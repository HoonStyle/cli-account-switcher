'use strict';
// electron-builder's cross-arch rebuild does not install NAPI optional packages
// for the other architecture. Keep both separately named libraries in universal
// apps; the NAPI loader chooses one using process.arch. Never relabel ARM as x64.
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');
const { execFileSync } = require('child_process');
module.exports = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const project = context.appDir || context.packager?.projectDir || path.resolve(__dirname, '..');
  const lock = JSON.parse(fs.readFileSync(path.join(project, 'package-lock.json'), 'utf8'));
  for (const arch of ['arm64', 'x64']) {
    const name = `@napi-rs/keyring-darwin-${arch}`, item = lock.packages[`node_modules/${name}`];
    if (!item || item.version !== '2.1.2' || !item.integrity?.startsWith('sha512-') || new URL(item.resolved).hostname !== 'registry.npmjs.org') throw Error('Missing pinned keyring package integrity');
    const destination = path.join(project, 'node_modules', name);
    const binary = path.join(destination, `keyring.darwin-${arch}.node`);
    if (!fs.existsSync(binary)) {
      const response = await fetch(item.resolved);
      if (!response.ok) throw Error(`Keyring package fetch failed: ${response.status}`);
      const bytes = Buffer.from(await response.arrayBuffer());
      if ('sha512-' + crypto.createHash('sha512').update(bytes).digest('base64') !== item.integrity) throw Error('Keyring package integrity mismatch');
      const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'switcher-keyring-build-'));
      try {
        const archive = path.join(temporary, 'package.tgz'); fs.writeFileSync(archive, bytes);
        const output = path.join(temporary, 'package'); fs.mkdirSync(output);
        execFileSync('/usr/bin/tar', ['-xzf', archive, '-C', output, '--strip-components=1'], { stdio: 'pipe' });
        const pkg = JSON.parse(fs.readFileSync(path.join(output, 'package.json'), 'utf8'));
        if (pkg.name !== name || pkg.version !== item.version) throw Error('Keyring package identity mismatch');
        fs.mkdirSync(destination, { recursive: true });
        for (const entry of fs.readdirSync(output, { withFileTypes: true })) {
          if (!entry.isFile()) throw Error('Unexpected keyring package member');
          fs.copyFileSync(path.join(output, entry.name), path.join(destination, entry.name));
        }
      } finally { fs.rmSync(temporary, { recursive: true, force: true }); }
    }
    execFileSync('/usr/bin/lipo', ['-verify_arch', arch === 'x64' ? 'x86_64' : 'arm64', binary], { stdio: 'pipe' });
  }
};
