'use strict';
const { createHash } = require('crypto');
const hash = value => createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(value)).digest('hex');
const deliveryId = (r, kind, version) => hash([r.id, r.generation, kind, version]);
function current(r, kind, version) {
  return kind === 'attention' ? r.status === 'needs_user' && r.inputRequest?.version === version && !r.inputRequest.consumedBy
    : kind === 'final' && ['ready', 'completed'].includes(r.status) && r.finalVersion === version;
}
function content(r, kind) {
  return kind === 'final' ? r.finalResponse
    : `[작업 알림 · CLI Account Switcher]\n${r.inputRequest.summary || r.inputRequest.reason}\n작업 ${r.id} · 질문 ${r.inputRequest.version}\n현재 질문에 답변하시면 이어갑니다.`;
}
function makeDelivery(r, kind, version, state = 'pending') {
  const text = content(r, kind);
  return { id: deliveryId(r, kind, version), rootId: r.id, generation: r.generation, kind, version, state,
    owner: r.coordinator, target:r.coordinator.deliveryTarget, payloadHash: hash(text), createdAt: r.updatedAt || r.createdAt || Date.now() };
}
function migrateRootDelivery(r) {
  if (r.coordinator?.tool !== 'openclaw') return [];
  const notices = [];
  if (['ready', 'completed'].includes(r.status) && r.finalVersion > 0 && typeof r.finalResponse === 'string') {
    const uncertain = r.finalDelivery === 'delivered' || r.status === 'completed' || r.deliveryWakeAttempts > 0;
    const state = uncertain ? 'unknown' : 'pending';
    notices.push(makeDelivery(r, 'final', r.finalVersion, state));
    r.finalDelivery = state;
    if (r.status === 'completed') r.status = 'ready';
  }
  if (r.status === 'needs_user' && r.inputRequest?.version > 0) {
    const state = r.attentionDelivery === 'delivered' || r.attentionWakeAttempts > 0 ? 'unknown' : 'pending';
    notices.push(makeDelivery(r, 'attention', r.inputRequest.version, state)); r.attentionDelivery = state;
  }
  return notices;
}
module.exports = { hash, deliveryId, current, content, makeDelivery, migrateRootDelivery };
