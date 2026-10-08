// One service-owned sender. Model wakes never own notice or final delivery.
const normalizedTarget = value => String(value ?? '').replace(/^(channel|chat|room|conversation):/, '');
export async function deliverPending(api, client, pending, isStopped, sendHost, readReceipt) {
  const kind = pending.kind === 'delivery' ? 'final' : 'attention';
  const version = kind === 'final' ? pending.finalVersion : pending.attentionVersion;
  const ack = () => client.request('bridgeAction', {id:pending.rootId,owner:pending.owner,action:kind === 'final' ? 'ack' : 'ack_attention',version});
  if (pending.noticeState === 'delivered') { await ack(); return; }
  if (!client.requestFromHost || !client.signDeliveryReceipt) throw Error('Compatible host delivery bridge required');
  const recovering=pending.noticeState === 'unknown';
  if(recovering) {
    if(!readReceipt) { try { readReceipt=(await import('openclaw/plugin-sdk/channel-outbound')).readSessionBoundMessageReceipt; } catch {} }
    if(typeof readReceipt !== 'function') return;
  } else {
    sendHost ??= (await import('openclaw/plugin-sdk/channel-outbound')).sendSessionBoundMessageBatch;
    if (typeof sendHost !== 'function') throw Error('Host lacks session-bound durable sender; no message was sent');
  }
  const notice = await client.requestFromHost(recovering ? 'bridgeReadDelivery' : 'bridgeClaimDelivery', {id:pending.rootId,kind,version,owner:pending.owner});
  if (!notice) return;
  const proof = {deliveryId:notice.id,rootId:notice.rootId,kind,version,generation:notice.generation,
    claimToken:notice.claimToken,payloadHash:notice.payloadHash,owner:notice.owner,outcome:'not_sent'};
  let attempted = false;
  const assertCurrent = () => {
    const entry = api.runtime.agent.session.getSessionEntry({agentId:pending.owner.agentId,sessionKey:pending.owner.sessionKey,readConsistency:'latest'});
    if (isStopped() || entry?.sessionId !== pending.owner.sessionId || (entry.lifecycleRevision ?? null) !== (pending.owner.lifecycleRevision ?? null)) throw Error('Original session no longer current');
    const route=entry.delivery?.kind === 'external' ? entry.delivery.context : null;
    if (!notice.target || !route?.channel || !route.to || !route.accountId || notice.target.channel !== route.channel || notice.target.accountId !== route.accountId || notice.target.to !== route.to || String(notice.target.threadId ?? '') !== String(route.threadId ?? '')) throw Error('Original delivery target changed; explicit readmission required');
    return route;
  };
  try {
    const route=assertCurrent();
    Object.assign(proof,{channel:route.channel,accountId:route.accountId,destination:route.to,threadId:route.threadId ?? null});
    const idempotencyKey=`switcher-${notice.id}`;
    const result=await (recovering ? readReceipt : sendHost)({agentId:pending.owner.agentId,sessionKey:pending.owner.sessionKey,sessionId:pending.owner.sessionId,
      lifecycleRevision:pending.owner.lifecycleRevision ?? null,target:notice.target,text:notice.text,idempotencyKey,assertCurrent,
      onPlatformSendDispatch:async()=>{
        assertCurrent();
        // A lost begin reply is unknown, never permission to send again.
        attempted=true;
        try { await client.requestFromHost('bridgeBeginDelivery',{id:pending.rootId,kind,version,owner:pending.owner,claimToken:notice.claimToken}); }
        catch(error) { if(error.code === 'DELIVERY_SUPERSEDED') attempted=false; throw error; }
        assertCurrent();
      }});
    if(recovering && !result) return;
    const parts=result?.receipt?.parts, target=result?.target;
    if(result?.status !== 'sent' || result.deliveryReceiptVersion !== 1 || result.idempotencyKey !== idempotencyKey || result.sessionId !== pending.owner.sessionId || (result.lifecycleRevision ?? null) !== (pending.owner.lifecycleRevision ?? null) || !target || target.channel !== route.channel || target.accountId !== route.accountId || target.to !== route.to || String(target.threadId ?? '') !== String(route.threadId ?? '') || !Array.isArray(parts) || !parts.length || parts.some(p=>typeof p.platformMessageId !== 'string' || !p.platformMessageId)) {
      if(result?.status === 'partial_failed') proof.parts=parts?.map(p=>({messageId:p.platformMessageId,index:p.index,kind:p.kind}));
      throw Error('Host returned no matching complete aggregate receipt');
    }
    const physicalTargets=new Set([normalizedTarget(route.to), ...(route.threadId == null ? [] : [normalizedTarget(route.threadId)])]);
    for(const part of parts) {
      const raw=part.raw;
      const actual=raw?.target?.id ?? raw?.channelId ?? raw?.chatId ?? raw?.roomId ?? raw?.conversationId ?? raw?.toJid;
      if((raw?.channel && raw.channel !== route.channel) || (actual && !physicalTargets.has(normalizedTarget(actual))) || (part.threadId && String(part.threadId) !== String(route.threadId ?? ''))) throw Error('Platform receipt route mismatch');
    }
    if(recovering) { if(result.source !== 'retained-completion') throw Error('Recovery requires a retained host receipt'); }
    else if(!attempted) throw Error('Host did not redeem durable dispatch fence');
    proof.outcome='sent';proof.receiptVersion=1;proof.parts=parts.map(p=>({messageId:p.platformMessageId,index:p.index,kind:p.kind}));
  } catch(error) {
    proof.outcome=(recovering || attempted) ? 'unknown' : 'not_sent';proof.reason=(recovering || attempted) ? 'HOST_SEND_OUTCOME_UNKNOWN' : 'HOST_SEND_ADMISSION_BLOCKED';
    api.logger.warn(`Switcher delivery ${notice.id}: ${proof.reason}`);
  }
  await client.requestFromHost('bridgeSettleDelivery',{receipt:client.signDeliveryReceipt(proof)});
  if(proof.outcome==='sent') await ack();
}
