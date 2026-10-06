'use strict';
const path = require('path');
const { normalizeModel } = require('../launch/model');
const { normalizeExecutionPolicy } = require('./execution-policy');
function text(value, name, max = 10000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new Error(`Invalid ${name}`);
  return value;
}
function submission(input, state) {
  if (!input || typeof input !== 'object') throw new Error('Task input is required');
  const mainTool = input.mainTool;
  if (mainTool !== 'openclaw' && (!['codex', 'claude'].includes(mainTool) || !state[mainTool].active)) throw new Error('An active main account is required');
  if (!['read-only', 'workspace-write'].includes(input.permission)) throw new Error('Invalid permission');
  if (!Array.isArray(input.participants) || input.participants.length < 1 || input.participants.length > 12) throw new Error('Select 1–12 participants');
  const participants = input.participants.map(p => {
    if (!p || !['codex', 'claude'].includes(p.tool) || !state[p.tool].profiles.includes(p.profileId)) throw new Error('Unregistered participant');
    return { tool: p.tool, profileId: p.profileId, model: normalizeModel(p.model) };
  });
  const projectPath = text(input.projectPath, 'project path', 4096);
  if (!path.isAbsolute(projectPath)) throw new Error('Project path must be absolute');
  const params = { requestId: text(input.requestId, 'request ID', 200), goal: text(input.goal, 'goal'), projectPath, mainTool, participants, permission: input.permission };
  params.executionPolicy = normalizeExecutionPolicy(input.permission, input.executionPolicy);
  params.mainModel = normalizeModel(input.mainModel);
  if (mainTool === 'openclaw') {
    if (params.mainModel) throw new Error('OpenClaw main model is controlled by its conversation');
    params.mainKind = 'openclaw'; params.bindingId = text(input.bindingId, 'OpenClaw binding', 200);
  }
  if (input.maxRounds !== undefined) {
    if (!Number.isInteger(input.maxRounds) || input.maxRounds < 1 || input.maxRounds > 10) throw new Error('maxRounds must be 1–10');
    params.maxRounds = input.maxRounds;
  }
  return params;
}
module.exports = { submission, text };
