'use strict';
const fs = require('fs'), path = require('path');
const { execFileSync } = require('child_process');
const { digest, failure, files, treeHash, copyEntries, copyFile, seal, verifyNativeClosure, validateSnapshot } = require('./research-snapshot');
const POLICY_REVISION = 'web-only-snapshot-v1';
const TOOLS = ['WebSearch', 'WebFetch', 'mcp__switcher_research__insane_search_fetch'];
const FLAGS = ['--restricted', '--mcp-config', '--strict-mcp-config', '--disable-slash-commands', '--permission-prompts', '--setting-sources', '--settings'];
// Policy glue around the installed transport, not another HTTP implementation.
// Every curl request uses a resolved public IP pinned with CURLOPT_RESOLVE;
// engine redirects still run through its own bounded per-hop loop.
const ENGINE_LAUNCHER = String.raw`import sys, os, json, runpy, socket, ipaddress
from urllib.parse import urlsplit
root = os.path.dirname(os.path.abspath(__file__))
sys.path[:] = [root, os.path.join(root, 'site-packages')] + [p for p in sys.path if 'site-packages' not in p]
from curl_cffi import requests as requests, CurlOpt
from engine import safety, transport
assert not transport.pool_enabled()
assert not safety.classify_url('http://127.0.0.1/')[0]
original_request = requests.Session.request
def public_addresses(url):
    p = urlsplit(url)
    if p.scheme not in ('http', 'https') or not p.hostname or p.username or p.password:
        raise ValueError('PUBLIC_URL_REQUIRED')
    port = p.port or (443 if p.scheme == 'https' else 80)
    try:
        addresses = [str(ipaddress.ip_address(p.hostname))]
    except ValueError:
        addresses = sorted({info[4][0] for info in socket.getaddrinfo(p.hostname, port, proto=socket.IPPROTO_TCP)})
    if not addresses or any(not ipaddress.ip_address(address).is_global for address in addresses):
        raise ValueError('PUBLIC_ADDRESS_REQUIRED')
    return p.hostname, port, addresses
def guarded_request(self, method, url, *args, **kwargs):
    if args or method.upper() not in ('GET', 'HEAD'):
        raise ValueError('READ_REQUEST_REQUIRED')
    host, port, addresses = public_addresses(url)
    # Never permit a proxy, automatic redirect, alternate resolver or auth.
    if any(kwargs.get(k) for k in ('auth', 'proxy', 'proxies', 'proxy_auth', 'doh_url', 'cert')):
        raise ValueError('PUBLIC_REQUEST_REQUIRED')
    options = dict(getattr(self, 'curl_options', {}) or {})
    encoded = ','.join('[' + a + ']' if ':' in a else a for a in addresses)
    options[CurlOpt.RESOLVE] = [f'{host}:{port}:{encoded}'.encode()]
    options[CurlOpt.PROXY] = b''
    self.curl_options = options
    kwargs['allow_redirects'] = False
    kwargs['max_redirects'] = 0
    return original_request(self, method, url, **kwargs)
requests.Session.request = guarded_request
if sys.argv[1:] == ['--preflight']:
    for bad in ['http://127.0.0.1/', 'http://[::1]/', 'http://10.0.0.1/', 'http://169.254.169.254/', 'https://user:pass@example.com/']:
        try:
            public_addresses(bad)
            raise AssertionError('private address accepted')
        except ValueError:
            pass
    print(json.dumps({'ready': True, 'privateTargets': 'denied', 'dns': 'public-pinned'}))
else:
    runpy.run_module('engine', run_name='__main__')
`;
function cleanEnv(scratch) {
  return { PATH: '/usr/bin:/bin', HOME: scratch, TMPDIR: scratch, PYTHONDONTWRITEBYTECODE: '1',
    INSANE_NO_SESSION_POOL: '1', INSANE_AUTO_INSTALL: '0', INSANE_SEARCH_XAI: 'off', INSANE_LEARN: '0', INSANE_ALLOW_PRIVATE: '0',
    INSANE_OBSERVATIONS_DIR: path.join(scratch, 'observations') };
}
function accountRef(binding) { return digest(JSON.stringify({ tool: binding.tool, profileId: binding.profileId || 'default', home: binding.home })); }
function inspect(binding, permission = 'read-only', executionPolicy = 'web-research') {
  if (binding?.tool !== 'claude' || permission !== 'read-only' || executionPolicy !== 'web-research') throw failure('POLICY_INCOMPATIBLE', 'web-research requires a Claude read-only task');
  if (process.platform !== 'darwin') throw failure('CAPABILITY_MISSING', 'Research snapshots currently require a relocatable macOS runtime');
  try {
    const executable = fs.realpathSync(binding.executable);
    const cliHash = digest(fs.readFileSync(executable));
    const probeEnv = { PATH: '/usr/bin:/bin', HOME: binding.home, PYTHONDONTWRITEBYTECODE: '1' };
    const cliVersion = execFileSync(executable, ['--version'], { encoding: 'utf8', timeout: 10000, env: probeEnv }).trim();
    const help = execFileSync(executable, ['--help'], { encoding: 'utf8', timeout: 10000, env: probeEnv });
    if (FLAGS.some(flag => !help.includes(flag))) throw failure('CAPABILITY_MISSING', 'Selected Claude CLI lacks required research isolation flags');
    const root = fs.realpathSync(path.join(binding.home, 'skills', 'insane-search'));
    for (const file of ['SKILL.md', 'engine/__main__.py', 'engine/safety.py', 'engine/transport.py']) fs.accessSync(path.join(root, file), fs.constants.R_OK);
    const python = fs.realpathSync(path.join(root, '.venv/bin/python'));
    const info = JSON.parse(execFileSync(python, ['-I', '-S', '-c', 'import sys,json; print(json.dumps({"base":sys.base_prefix,"version":"%s.%s" % sys.version_info[:2]}))'], { encoding: 'utf8', timeout: 10000, env: probeEnv }));
    const pythonRoot = fs.realpathSync(info.base);
    if (!/^3\.\d+$/.test(info.version)) throw failure('CAPABILITY_MISSING', 'Unsupported research Python runtime');
    let node = process.execPath;
    if (!/^node(?:\.exe)?$/.test(path.basename(node))) node = require('../wrappers').which('node');
    node = fs.realpathSync(node);
    const helper = path.join(__dirname, 'research-mcp.bundle.cjs');
    const engineEntries = files(path.join(root, 'engine'));
    const depsEntries = files(path.join(root, '.venv/lib', 'python' + info.version, 'site-packages'));
    const runtimeEntries = files(path.join(pythonRoot, 'lib'), { omitSitePackages: true });
    const helperHash = digest(fs.readFileSync(helper)), pythonHash = digest(fs.readFileSync(python)), nodeHash = digest(fs.readFileSync(node));
    const capability = { version: 1, accountBindingRef: accountRef(binding), provider: binding.tool, model: binding.model || '', cliVersion, cliPath: executable, cliHash,
      policy: 'web-research', policyRevision: POLICY_REVISION, required: [...TOOLS], declaredTools: [...TOOLS], helperHash,
      engineHash: treeHash(engineEntries), dependenciesHash: treeHash(depsEntries), runtimeHash: treeHash(runtimeEntries), pythonHash, nodeHash,
      guardHash: digest(ENGINE_LAUNCHER), nativeWebTools: 'not_live_verified' };
    capability.fingerprint = digest(JSON.stringify(capability));
    return { capability, root, pythonRoot, python, node, helper, engineEntries, depsEntries, runtimeEntries, version: info.version };
  } catch (error) {
    if (error.code?.startsWith('CAPABILITY_') || error.code === 'POLICY_INCOMPATIBLE') throw error;
    throw failure('CAPABILITY_MISSING', 'Selected account lacks a usable installed research engine, helper bundle, or runtime');
  }
}
function assertMatch(expected, actual) {
  if (expected && expected.fingerprint !== actual.fingerprint) throw failure('CAPABILITY_STALE', 'Selected research capability changed; explicit revalidation is required');
}
function preflightResearch({ binding, permission = 'read-only', executionPolicy = 'web-research' }) {
  const found = inspect(binding, permission, executionPolicy);
  try {
    // Submission-time import and SDK checks are repeated against the sealed
    // attempt copy. Neither stage makes model/provider/network calls.
    const preflight = 'import sys; sys.path[:0]=' + JSON.stringify([found.root, path.join(found.root, '.venv/lib', 'python' + found.version, 'site-packages')]) + '; import engine.safety, engine.transport, curl_cffi; assert not engine.transport.pool_enabled(); assert not engine.safety.classify_url("http://127.0.0.1/")[0]';
    execFileSync(found.python, ['-I', '-S', '-c', preflight], { env: cleanEnv(found.root), timeout: 15000, stdio: 'pipe' });
    const protocol = JSON.parse(execFileSync(found.node, [found.helper, '--self-test'], { env: cleanEnv(found.root), timeout: 15000, encoding: 'utf8' }));
    if (protocol.ready !== true) throw Error('protocol');
    return found.capability;
  } catch { throw failure('CAPABILITY_MISSING', 'Selected research dependencies or MCP protocol failed preflight'); }
}
function researchSettings({ binding, permission = 'read-only', dir, capabilitySnapshot }) {
  const inspected = inspect(binding, permission); assertMatch(capabilitySnapshot, inspected.capability);
  const { capability } = inspected;
  let snapshot;
  try {
    snapshot = fs.mkdtempSync(path.join(dir, 'research-assets-')); fs.chmodSync(snapshot, 0o700);
    copyEntries(inspected.engineEntries, path.join(snapshot, 'engine'));
    copyEntries(inspected.depsEntries, path.join(snapshot, 'site-packages'));
    fs.mkdirSync(path.join(snapshot, 'python'), { mode: 0o700 });
    copyEntries(inspected.runtimeEntries, path.join(snapshot, 'python/lib'));
    fs.mkdirSync(path.join(snapshot, 'python/bin'), { mode: 0o700 });
    copyFile(inspected.python, path.join(snapshot, 'python/bin/python'), capability.pythonHash, true);
    copyFile(inspected.node, path.join(snapshot, 'node'), capability.nodeHash, true);
    copyFile(inspected.helper, path.join(snapshot, 'helper.cjs'), capability.helperHash);
    fs.writeFileSync(path.join(snapshot, 'engine-launch.py'), ENGINE_LAUNCHER, { mode: 0o400, flag: 'wx' });
    // No non-OS absolute linkage back to the source installation is accepted.
    verifyNativeClosure(path.join(snapshot, 'node'), snapshot, true);
    verifyNativeClosure(path.join(snapshot, 'python/bin/python'), snapshot, true);
    for (const item of files(snapshot)) verifyNativeClosure(item.file, snapshot);
    const scratch = fs.mkdtempSync(path.join(dir, 'research-cache-')); fs.chmodSync(scratch, 0o700);
    const pythonEnv = { ...cleanEnv(scratch), PYTHONHOME: path.join(snapshot, 'python') };
    const result = JSON.parse(execFileSync(path.join(snapshot, 'python/bin/python'), ['-s', '-S', path.join(snapshot, 'engine-launch.py'), '--preflight'], { cwd: snapshot, env: pythonEnv, encoding: 'utf8', timeout: 15000 }));
    if (result.ready !== true || result.privateTargets !== 'denied' || result.dns !== 'public-pinned') throw failure('CAPABILITY_MISSING', 'Research dependency preflight failed');
    // SDK and transport initialization are verified without a provider call.
    const protocol = JSON.parse(execFileSync(path.join(snapshot, 'node'), [path.join(snapshot, 'helper.cjs'), '--self-test'], { env: cleanEnv(scratch), encoding: 'utf8', timeout: 15000 }));
    if (protocol.ready !== true || protocol.tool !== 'insane_search_fetch') throw failure('CAPABILITY_MISSING', 'Research MCP preflight failed');
    const manifest = { version: 1, capability, assetsHash: treeHash(files(snapshot)) };
    const snapshotHash = digest(JSON.stringify(manifest));
    fs.writeFileSync(path.join(snapshot, 'manifest.json'), JSON.stringify(manifest), { mode: 0o400, flag: 'wx' }); seal(snapshot);
    const settingsFile = path.join(dir, 'research-settings.json');
    fs.writeFileSync(settingsFile, JSON.stringify({ disableAllHooks: true, permissions: { defaultMode: 'dontAsk', allow: TOOLS,
      deny: ['Read', 'Glob', 'Grep', 'Bash', 'Edit', 'Write', 'Agent', 'Task'] } }), { flag: 'wx', mode: 0o600 });
    const mcpFile = path.join(dir, 'research-mcp.json');
    fs.writeFileSync(mcpFile, JSON.stringify({ mcpServers: { switcher_research: { command: path.join(snapshot, 'node'),
      args: [path.join(snapshot, 'helper.cjs'), snapshot, scratch, snapshotHash], env: cleanEnv(scratch) } } }), { flag: 'wx', mode: 0o600 });
    return { settingsFile, mcpFile, env: { PATH: '/usr/bin:/bin' }, researchSnapshot: { path: snapshot, hash: snapshotHash, capability,
      settingsHash: digest(fs.readFileSync(settingsFile)), mcpHash: digest(fs.readFileSync(mcpFile)), settingsFile, mcpFile } };
  } catch (error) {
    // Retain failed preparation evidence in its private attempt directory; the
    // ordinary attempt-retention owner may remove it only after execution ends.
    if (error.code?.startsWith('CAPABILITY_')) throw error;
    throw failure('CAPABILITY_MISSING', 'Research snapshot could not pass isolated dependency/protocol validation');
  }
}
function validateResearchInvocation(binding, invocation) {
  const state = invocation.researchSnapshot; if (!state) return;
  const cap = state.capability;
  try {
    if (cap.accountBindingRef !== accountRef(binding) || cap.model !== (binding.model || '') || cap.policyRevision !== POLICY_REVISION ||
        fs.realpathSync(binding.executable) !== cap.cliPath || digest(fs.readFileSync(binding.executable)) !== cap.cliHash) throw Error('binding changed');
    const manifest = validateSnapshot(state.path, state.hash);
    if (manifest.capability.fingerprint !== cap.fingerprint || digest(fs.readFileSync(state.settingsFile)) !== state.settingsHash || digest(fs.readFileSync(state.mcpFile)) !== state.mcpHash) throw Error('snapshot mismatch');
  } catch { throw failure('CAPABILITY_STALE', 'Research binding, CLI, policy or prepared snapshot changed before model spawn'); }
}
module.exports = { POLICY_REVISION, TOOLS, FLAGS, ENGINE_LAUNCHER, cleanEnv, preflightResearch, researchSettings, validateResearchInvocation };
