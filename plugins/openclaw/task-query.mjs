// One canonical projector is shared by source tests and the bundled service.
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const require = createRequire(import.meta.url);
const source = fileURLToPath(new URL('../../src/runtime/query.js', import.meta.url));
const bundled = fileURLToPath(new URL('./lib/runtime/query.js', import.meta.url));
const query = require(existsSync(source) ? source : bundled);
export const { QUERY_SCHEMA, MAX_REPLY_BYTES, projectQuery, queryReply } = query;
