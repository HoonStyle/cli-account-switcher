'use strict';
// Gemini API (Google AI Studio) accounts: API-key only, no CLI home. Google ended Gemini CLI
// service for individual and Google AI Pro/Ultra accounts on 2026-06-18 (those moved to
// Antigravity CLI, handled by antigravity.js), so the Gemini category here is the API key path
// used by OpenAI-compatible tools and Google's stateless `gemini-api` CLI.
const { create } = require('./api-provider');

const BASE_URL = 'https://generativelanguage.googleapis.com/v1beta/openai';
const MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';

module.exports = create({
  id: 'gemini-api',
  aliases: ['gemini'],
  label: 'Gemini API',
  shortName: 'Gemini',
  baseUrl: BASE_URL,
  model: null, // model names rotate quickly; the tool or script chooses one
  docs: 'https://ai.google.dev/gemini-api/docs',
  // Inherited Google/OpenAI variables are removed so only this account's key reaches the child.
  strip: /^(GEMINI_.*|GOOGLE_API_KEY|GOOGLE_GENAI_.*|OPENAI_.*)$/i,
  env: (key, p) => ({ GEMINI_API_KEY: key, GOOGLE_API_KEY: key, GEMINI_BASE_URL: p.BASE_URL, OPENAI_API_KEY: key, OPENAI_BASE_URL: p.BASE_URL }),
  keyHint: 'AIza…',
  keyWarning: { pattern: /^AIza/, text: 'Gemini API 키는 보통 AIza 로 시작합니다' },
  check: {
    describe: 'GET /v1beta/models',
    url: () => MODELS_URL,
    headers: (key) => ({ 'x-goog-api-key': key }),
    models: (body) => (Array.isArray(body && body.models) ? body.models : [])
      .map((m) => (m && typeof m.name === 'string' ? m.name.replace(/^models\//, '') : null))
      .filter((n) => n && /^gemini/i.test(n)),
    rateLimits: null,
  },
});
