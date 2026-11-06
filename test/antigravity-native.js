'use strict';
// Dedicated disposable OS-keyring entries only. Never accesses gemini:antigravity.
const assert = require('assert/strict');
const { execFileSync } = require('child_process');
const service = 'dev.hoonstyle.switcher-test.' + require('crypto').randomUUID();
const account = 'fixture', value = '{"fixture":"한글 UTF8 \\" quoted"}';
const vault = require('../src/antigravity').nativeVault();
(async () => {
  try {
    assert.equal(await vault.get(service, account), null);
    await vault.set(service, account, value);
    assert.equal(await vault.get(service, account), value);
    console.log('PASS disposable native keyring UTF8 write/read');
    if (process.platform === 'darwin' && process.env.AGY_TEST_CROSS_READ === '1') {
      const observed = execFileSync('/usr/bin/security', ['find-generic-password', '-s', service, '-a', account, '-w'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 8000 });
      assert.equal(observed.trimEnd(), value, 'compatible generic-password service/account and UTF8 bytes');
    }
    console.log(process.env.AGY_TEST_CROSS_READ === '1' ? 'PASS platform cross-read compatibility' : 'SKIP cross-process ACL check (requires explicit OS permission; set AGY_TEST_CROSS_READ=1)');
  } finally { await vault.remove(service, account); assert.equal(await vault.get(service, account), null); console.log('PASS disposable keyring entry removed'); }
})().catch(() => { console.error('FAIL native keyring compatibility; no real account entry was accessed'); process.exitCode = 1; });
