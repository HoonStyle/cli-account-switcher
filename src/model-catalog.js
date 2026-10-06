'use strict';
const fs = require('fs');
const path = require('path');
const { normalizeModel } = require('./launch/model');

// Selector catalog only: the provider CLI remains responsible for access checks.
// Claude full IDs verified 2026-10-06:
// https://platform.claude.com/docs/en/models/overview
const CLAUDE_MODELS = [
  { id: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
  { id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5' },
  { id: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
];
function readJson(file) {
  try {
    if (fs.statSync(file).size > 4 * 1024 * 1024) return null;
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}
function clean(models) {
  const seen = new Set(), result = [];
  for (const model of models) {
    let id;
    try { id = normalizeModel(model?.id); } catch { continue; }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const label = typeof model.label === 'string' ? model.label.replace(/\s+/g, ' ').trim().slice(0, 160) : '';
    result.push({ id, label: label || id });
  }
  return result;
}
function modelCatalog(tool, home) {
  if (tool === 'codex') {
    // Never borrow another account's catalog or expose cache identity/instructions.
    const cache = readJson(path.join(home, 'models_cache.json'));
    return clean((Array.isArray(cache?.models) ? cache.models : [])
      .filter(m => m?.visibility === 'list')
      .map(m => ({ id: m.slug, label: m.display_name })));
  }
  if (tool === 'claude') {
    const configured = readJson(path.join(home, 'settings.json'))?.model;
    return clean([...CLAUDE_MODELS, ...(typeof configured === 'string' ? [{ id: configured, label: configured }] : [])]);
  }
  return [];
}
module.exports = { modelCatalog };
