'use strict';

// Model availability belongs to the provider CLI, not a stale bundled catalog.
// Validate the identifier only; never turn it into shell text or CLI options.
function normalizeModel(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new Error('Model must be a string');
  const model = value.trim();
  if (!model) return undefined;
  if (!/^[A-Za-z0-9][A-Za-z0-9._:/@+\[\]-]{0,199}$/.test(model)) throw new Error('Invalid model identifier (maximum 200 characters; no spaces or options)');
  return model;
}

function withModel(binding, value) {
  const model = normalizeModel(value);
  return model === undefined ? binding : { ...binding, model };
}

module.exports = { normalizeModel, withModel };
