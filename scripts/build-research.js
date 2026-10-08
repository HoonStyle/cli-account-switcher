'use strict';
// Maintained SDK bundled into the immutable attempt helper; no runtime npm
// lookup into user homes or installations that can change between fetches.
require('esbuild').buildSync({
  entryPoints: [require('path').join(__dirname, '../src/runtime/research-mcp.js')],
  outfile: require('path').join(__dirname, '../src/runtime/research-mcp.bundle.cjs'),
  bundle: true, platform: 'node', target: 'node22', format: 'cjs', legalComments: 'inline',
});
