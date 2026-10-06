'use strict';
const fs = require('fs');
const path = require('path');
const { randomUUID } = require('crypto');
const { normalizeModel } = require('../launch/model');
const { normalizeExecutionPolicy, buildSettings } = require('../runtime/execution-policy');
const mainSchema = { type: 'object', additionalProperties: false, required: ['kind', 'summary', 'delegations', 'reviews', 'finalResponse'], properties: {
  kind: { type: 'string', enum: ['delegate', 'complete', 'needs_user'] }, summary: { type: 'string' },
  delegations: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['participantId', 'goal', 'resolvesTaskIds', 'inputs'], properties: { participantId: { type: 'string' }, goal: { type: 'string' }, resolvesTaskIds: { type: 'array', items: { type: 'string' } }, inputs: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['taskId', 'resultVersion', 'paths'], properties: { taskId: { type: 'string' }, resultVersion: { type: 'integer' }, paths: { type: 'array', items: { type: 'string' } } } } } } } },
  reviews: { type: 'array', items: { type: 'object', additionalProperties: false, required: ['taskId', 'resultVersion', 'decision', 'reason'], properties: { taskId: { type: 'string' }, resultVersion: { type: 'integer' }, decision: { type: 'string', enum: ['accepted', 'rejected', 'needs_user'] }, reason: { type: 'string' } } } },
  finalResponse: { type: 'string' },
} };
const childSchema = { type: 'object', additionalProperties: false, required: ['success', 'summary', 'artifacts'], properties: { success: { type: 'boolean' }, summary: { type: 'string' }, artifacts: { type: 'array', items: { type: 'string' } } } };
function buildInvocation({ binding, role, sessionId, permission, executionPolicy, cwd, dir }) {
  const policy = normalizeExecutionPolicy(permission, executionPolicy);
  const model = normalizeModel(binding.model);
  const schema = role === 'child' ? childSchema : mainSchema;
  const schemaFile = path.join(dir, 'schema.json');
  fs.writeFileSync(schemaFile, JSON.stringify(schema), { mode: 0o600 });
  const outputFile = path.join(dir, 'last-response.txt');
  let args, executionEnv, expectedSession = sessionId;
  if (binding.tool === 'claude') {
    args = ['--safe-mode', '--strict-mcp-config', '--tools', role === 'child' ? (permission === 'workspace-write' ? 'Read,Glob,Grep,Edit,Write' : 'Read,Glob,Grep') : '', '--permission-mode', role === 'child' && permission === 'workspace-write' ? 'acceptEdits' : 'dontAsk', '-p', '--output-format', 'stream-json', '--verbose', '--json-schema', JSON.stringify(schema)];
    if (role === 'child' && policy === 'build-test') {
      const prepared = buildSettings({ binding, cwd, dir });
      args[args.indexOf('--tools') + 1] += ',Bash';
      args.push('--restricted', '--setting-sources', '', '--settings', prepared.settingsFile, '--permission-prompts', 'none');
      executionEnv = prepared.env;
    }
    if (model) args.push('--model', model);
    if (sessionId) args.push('--resume', sessionId);
    else { expectedSession = randomUUID(); args.push('--session-id', expectedSession); }
  } else if (binding.tool === 'codex') {
    args = ['exec'];
    if (sessionId) args.push('resume');
    args.push('--ignore-user-config', '--ignore-rules', '--json', '--skip-git-repo-check', '-c', 'approval_policy="never"', '-c', `sandbox_mode="${role === 'child' ? permission : 'read-only'}"`, '--output-schema', schemaFile, '-o', outputFile);
    if (model) args.push('--model', model);
    if (sessionId) args.push(sessionId);
    args.push('-');
  } else throw new Error('Unsupported CLI adapter');
  return { executable: binding.executable, args, expectedSession, outputFile, ...(executionEnv ? { executionEnv } : {}) };
}
function parseJSON(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  return JSON.parse(trimmed);
}
function parseOutput(tool, stdout, invocation) {
  if (tool === 'claude') {
    let out;
    try { out = parseJSON(stdout); } catch {
      out = stdout.split(/\r?\n/).filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(event => event?.type === 'result').at(-1);
    }
    if (!out) throw new Error('Missing Claude result event');
    if (out.is_error || out.subtype !== 'success') throw new Error(`Claude result: ${out.subtype || 'error'}`);
    return { sessionId: out.session_id, result: out.structured_output || parseJSON(out.result || '') };
  }
  const events = stdout.split(/\r?\n/).filter(Boolean).map(s => { try { return JSON.parse(s); } catch { return {}; } });
  if (events.some(e => e.type === 'turn.failed' || e.type === 'error')) throw new Error('Codex turn failed; inspect private attempt logs');
  const sessionId = events.find(e => e.type === 'thread.started')?.thread_id || invocation.expectedSession;
  const text = fs.existsSync(invocation.outputFile) ? fs.readFileSync(invocation.outputFile, 'utf8') : events.filter(e => e.type === 'item.completed' && e.item?.type === 'agent_message').at(-1)?.item.text;
  return { sessionId, result: parseJSON(text || '') };
}
module.exports = { mainSchema, childSchema, buildInvocation, parseOutput };
