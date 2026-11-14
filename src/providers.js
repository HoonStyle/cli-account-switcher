'use strict';
// API-key provider categories in display order. Each module comes from api-provider.create.
const list = [require('./exaone'), require('./gemini-api')];
const byId = Object.fromEntries(list.map((p) => [p.ID, p]));

// Resolve a CLI command name or alias (e.g. 'gemini' → gemini-api) to a provider, or null.
function find(name) { return list.find((p) => p.ID === name || p.ALIASES.includes(name)) || null; }

module.exports = { list, byId, find };
