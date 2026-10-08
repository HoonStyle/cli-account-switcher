'use strict';
// The local socket trusts the OS account, not model-supplied receipt fields.
// Only the host bridge reads this 0600 capability; it is never a tool parameter.
const fs = require('fs'), path = require('path');
const { randomBytes, createHmac, timingSafeEqual } = require('crypto');
const canonical = value => JSON.stringify(value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(v => JSON.parse(canonical(v)))
    : Object.fromEntries(Object.keys(value).sort().filter(k => value[k] !== undefined).map(k => [k, JSON.parse(canonical(value[k]))]))
  : value);
function bridgeKey(dir, create = false) {
  const file = path.join(dir, 'bridge-host.key');
  if (create) {
    try { const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, randomBytes(32)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
  }
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || (process.platform !== 'win32' && (stat.mode & 0o077)) || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) throw Error('Invalid bridge host capability file');
  const key = fs.readFileSync(file); if (key.length !== 32) throw Error('Invalid bridge host capability'); return key;
}
const sign = (key, domain, value) => createHmac('sha256', key).update(domain + '\n' + canonical(value)).digest('hex');
function verify(key, domain, value, signature) {
  if (typeof signature !== 'string' || !/^[a-f0-9]{64}$/.test(signature)) return false;
  return timingSafeEqual(Buffer.from(sign(key, domain, value), 'hex'), Buffer.from(signature, 'hex'));
}
function hostRequest(dir, method, params) { return { ...params, hostAuthorization: sign(bridgeKey(dir), method, params) }; }
function assertHostRequest(key, method, payload) {
  const { hostAuthorization, ...params } = payload;
  if (!verify(key, method, params, hostAuthorization)) throw Object.assign(Error('Authenticated host bridge required'), { code: 'HOST_BRIDGE_REQUIRED' });
  return params;
}
function signDeliveryReceipt(dir, statement) { return { statement, signature: sign(bridgeKey(dir), 'delivery-receipt-v1', statement) }; }
function verifyDeliveryReceipt(key, envelope) {
  if (!envelope || !verify(key, 'delivery-receipt-v1', envelope.statement, envelope.signature)) throw Object.assign(Error('A verified host delivery receipt is required'), { code: 'DELIVERY_RECEIPT_REQUIRED' });
  return envelope.statement;
}
module.exports = { bridgeKey, hostRequest, assertHostRequest, signDeliveryReceipt, verifyDeliveryReceipt };
