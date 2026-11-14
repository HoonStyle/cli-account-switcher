'use strict';
// EXAONE API Platform (LG AI Research) accounts. API-key only and OpenAI-compatible
// (POST /v1/chat/completions); there is no CLI home to isolate, so this is a provider
// category beside Claude/Codex, never a member of paths.TOOLS. See api-provider.js for the
// shared behaviour (key storage, env injection, run, live check, snapshot).
const { create, windowRateLimits } = require('./api-provider');

const BASE_URL = 'https://api.exaone.ai/v1';

module.exports = create({
  id: 'exaone',
  label: 'EXAONE API',
  shortName: 'EXAONE',
  baseUrl: BASE_URL,
  model: 'k-exaone_v2.5',
  docs: 'https://docs.exaone.ai/ko/docs/k-exaone-2.5',
  // Inherited provider variables are removed so only this account's key reaches the child.
  strip: /^(EXAONE_.*|OPENAI_.*)$/i,
  env: (key, p) => ({ EXAONE_API_KEY: key, EXAONE_BASE_URL: p.BASE_URL, EXAONE_MODEL: p.MODEL, OPENAI_API_KEY: key, OPENAI_BASE_URL: p.BASE_URL }),
  keyHint: 'sk-…',
  keyWarning: { pattern: /^sk-/, text: 'EXAONE API 키는 보통 sk- 로 시작합니다' },
  check: {
    describe: 'GET /v1/models',
    url: (p) => `${p.BASE_URL}/models`,
    headers: (key) => ({ Authorization: `Bearer ${key}` }),
    models: (body) => (Array.isArray(body && body.data) ? body.data.map((m) => m && m.id) : []),
    // Rate limit headers documented by the platform: x-{second,minute,day}-rate-limit(-remaining).
    rateLimits: windowRateLimits(['second', 'minute', 'day']),
  },
});
