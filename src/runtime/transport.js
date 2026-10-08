'use strict';
// Limits include the complete UTF-8 JSON envelope and its terminating newline.
// Keep client preflight and server enforcement on the same wire contract.
const REQUEST_LIMIT = 1024 * 1024;
const RESPONSE_LIMIT = 8 * 1024 * 1024;
const PROTOCOL_VERSION = 3;
const HELLO_METHOD = 'hello';
const TRANSPORT = Object.freeze({ protocolVersion: PROTOCOL_VERSION, requestMaxBytes: REQUEST_LIMIT, responseMaxBytes: RESPONSE_LIMIT, encoding: 'utf8', framing: 'newline-json', mutationHandshake: 'same-connection' });
// Everything else (including unknown future methods) requires negotiation.
function isReadOnly(method) {
  return ['health', 'list', 'get', 'output', 'query', 'dashboard', 'dashboardList', 'bridgeAllBindings', 'bridgeBindings', 'bridgePending', 'bridgeGet', 'bridgeQuery'].includes(method);
}
function protocolMismatch(reason = 'The running task service does not support the required protocol') {
  const error = new Error(`${reason}. Task protocol ${PROTOCOL_VERSION} with a same-connection handshake is required. No action was applied. Existing executions are preserved; update the app/plugin and explicitly restart the task service when safe. Do not resubmit the task or force-stop running work.`);
  error.code = 'ERR_TASK_PROTOCOL_MISMATCH';
  return error;
}
function assertTransport(info) {
  if (!info || Object.entries(TRANSPORT).some(([key, value]) => info[key] !== value)) throw protocolMismatch();
  return info;
}
function requestTooLarge(requestBytes) {
  const error = new Error(`Task request is ${requestBytes} bytes; the UTF-8 JSON envelope limit is ${REQUEST_LIMIT} bytes (1 MiB). No action was applied. Shorten the request and retry the same task/attempt/generation; do not submit a duplicate task.`);
  error.code = 'ERR_TASK_REQUEST_TOO_LARGE';
  error.requestBytes = requestBytes;
  error.maxBytes = REQUEST_LIMIT;
  return error;
}
module.exports = { REQUEST_LIMIT, RESPONSE_LIMIT, PROTOCOL_VERSION, HELLO_METHOD, TRANSPORT, isReadOnly, assertTransport, protocolMismatch, requestTooLarge };
