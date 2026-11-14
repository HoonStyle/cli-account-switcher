'use strict';
// New Codex profiles share local plugins with the default home but keep the remote
// (ChatGPT-connected) plugin cache per account, so one account's remote install sync
// cannot delete another account's connector plugins.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cli-accounts-plugins-')));
process.env.HOME = tmp; process.env.USERPROFILE = tmp;
process.env.CLI_ACCOUNTS_ROOT = path.join(tmp, 'accounts');

try {
  const shared = path.join(tmp, '.codex', 'plugins');
  for (const d of ['cache/openai-bundled/browser/1/skills', 'cache/marketingskills/x/1/skills', 'cache/openai-curated-remote/google-drive/0.1.23/skills', '.plugin-appserver/codex-cli', '.remote-plugin-install-staging']) {
    fs.mkdirSync(path.join(shared, d), { recursive: true });
  }
  fs.writeFileSync(path.join(tmp, '.codex', 'config.toml'), 'model = "x"\n');

  const store = require('../src/store');
  const a = store.addProfile('codex', 'alpha');
  const b = store.addProfile('codex', 'beta');

  for (const r of [a, b]) {
    const plugins = path.join(r.home, 'plugins');
    assert.ok(!fs.lstatSync(plugins).isSymbolicLink(), 'plugins/ is a real directory per profile');
    assert.ok(fs.lstatSync(path.join(plugins, 'cache')).isDirectory() && !fs.lstatSync(path.join(plugins, 'cache')).isSymbolicLink());
    // Local and bundled plugins remain shared links to the default home.
    assert.strictEqual(fs.realpathSync(path.join(plugins, 'cache', 'openai-bundled')), path.join(shared, 'cache', 'openai-bundled'));
    assert.strictEqual(fs.realpathSync(path.join(plugins, 'cache', 'marketingskills')), path.join(shared, 'cache', 'marketingskills'));
    assert.strictEqual(fs.realpathSync(path.join(plugins, '.plugin-appserver')), path.join(shared, '.plugin-appserver'));
    // Remote plugin cache and install staging are per profile, not links.
    for (const rel of store.CODEX_PER_PROFILE_PLUGIN_PATHS) {
      const p = path.join(plugins, rel);
      assert.ok(fs.lstatSync(p).isDirectory() && !fs.lstatSync(p).isSymbolicLink(), rel + ' is per profile');
      assert.notStrictEqual(fs.realpathSync(p), path.join(shared, rel));
    }
    assert.ok(r.linked.includes(path.join('plugins', 'cache', 'openai-bundled')));
    assert.ok(!r.linked.some((x) => x.includes('openai-curated-remote')));
    // Other allowlisted items keep the original whole-item link behaviour.
    assert.ok(fs.lstatSync(path.join(r.home, 'config.toml')).isSymbolicLink());
  }

  // A sync in one profile removing a remote plugin must not touch the other profile or the default home.
  fs.mkdirSync(path.join(a.home, 'plugins', 'cache', 'openai-curated-remote', 'google-drive'), { recursive: true });
  fs.rmSync(path.join(a.home, 'plugins', 'cache', 'openai-curated-remote', 'google-drive'), { recursive: true });
  fs.mkdirSync(path.join(b.home, 'plugins', 'cache', 'openai-curated-remote', 'google-drive'), { recursive: true });
  assert.ok(fs.existsSync(path.join(b.home, 'plugins', 'cache', 'openai-curated-remote', 'google-drive')));
  assert.ok(fs.existsSync(path.join(shared, 'cache', 'openai-curated-remote', 'google-drive')));

  // Top-up is idempotent and adds a newly installed shared marketplace.
  fs.mkdirSync(path.join(shared, 'cache', 'newmarket', 'p', '1'), { recursive: true });
  const added = store.linkCodexPlugins(shared, path.join(a.home, 'plugins'));
  assert.deepStrictEqual(added, [path.join('plugins', 'cache', 'newmarket')]);
  assert.deepStrictEqual(store.linkCodexPlugins(shared, path.join(a.home, 'plugins')), []);

  // An existing whole-directory link (pre-isolation profile) is left untouched.
  const legacy = path.join(tmp, 'legacy');
  fs.mkdirSync(legacy);
  fs.symlinkSync(shared, path.join(legacy, 'plugins'));
  assert.deepStrictEqual(store.linkCodexPlugins(shared, path.join(legacy, 'plugins')), []);
  assert.ok(fs.lstatSync(path.join(legacy, 'plugins')).isSymbolicLink());

  // Deleting a profile removes its links, not the shared targets.
  store.removeProfile('codex', 'alpha', { deleteFiles: true });
  assert.ok(fs.existsSync(path.join(shared, 'cache', 'openai-bundled', 'browser')));
  assert.ok(fs.existsSync(path.join(shared, 'cache', 'marketingskills')));

  console.log('codex plugin isolation ok');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
