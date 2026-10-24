import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const [repoArgument, rootArgument] = process.argv.slice(2);
const repo = fs.realpathSync(repoArgument);
const root = path.resolve(rootArgument);
const harness = path.dirname(fileURLToPath(import.meta.url));
const sourcePin = 'a1bdd0c48332aa7f13bb3fe32ae85fdf2fc395ed';
const base = 'e0cf688b501a377d39f07d49e50ad7e1d7776702';
const versions = {'20.19.0': '10.0.0', '24.19.0': '11.17.0'};
assert.equal(process.platform, 'linux');
assert.equal(process.version, `v${process.env.EXPECTED_NODE}`);
assert.equal(versions[process.env.EXPECTED_NODE], process.env.SELECTED_NPM);
assert.ok(!fs.existsSync(root), 'Use a fresh disposable runner directory');
assert.ok(!repo.startsWith(root + path.sep));
for (const name of ['', 'user', 'tmp', 'prefix', 'cache', 'tools', 'appium-home']) fs.mkdirSync(path.join(root, name), {recursive: true});
for (const name of ['user.rc', 'global.rc']) fs.writeFileSync(path.join(root, name), '');
const env = {
  PATH: process.env.PATH,
  HOME: path.join(root, 'user'), TMPDIR: path.join(root, 'tmp'), TEMP: path.join(root, 'tmp'), TMP: path.join(root, 'tmp'),
  APPIUM_HOME: path.join(root, 'appium-home'),
  npm_config_prefix: path.join(root, 'prefix'), npm_config_cache: path.join(root, 'cache'),
  npm_config_userconfig: path.join(root, 'user.rc'), npm_config_globalconfig: path.join(root, 'global.rc'),
  npm_config_registry: 'https://registry.npmjs.org/', npm_config_ignore_scripts: 'true',
  npm_config_audit: 'false', npm_config_fund: 'false', npm_config_update_notifier: 'false',
  NO_COLOR: '1', CI: '1',
};
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
function run(executable, args, cwd = repo, expected = 0, timeout = 60000) {
  console.log(JSON.stringify({command: path.basename(executable), args, cwd}));
  const result = spawnSync(executable, args, {cwd, env, encoding: 'utf8', timeout, maxBuffer: 8 * 1024 * 1024});
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, expected);
  return result;
}
assert.equal(run('git', ['rev-parse', 'HEAD']).stdout.trim(), sourcePin);
console.log(JSON.stringify({sourcePin, tree: run('git', ['rev-parse', 'HEAD^{tree}']).stdout.trim(), os: fs.readFileSync('/etc/os-release', 'utf8'), node: process.version}));
const sourcePaths = [
  'packages/support/lib/npm.ts', 'packages/support/test/unit/npm.spec.ts',
  'packages/appium/docs/en/developing/build-drivers.md', 'packages/appium/docs/en/developing/build-plugins.md',
  'package-lock.json',
];
const before = Object.fromEntries(sourcePaths.map((name) => [name, hash(fs.readFileSync(path.join(repo, name)))]));
console.log(JSON.stringify({sourceSha256: before}));
const bundledNpm = path.resolve(path.dirname(process.execPath), '../lib/node_modules/npm/bin/npm-cli.js');
assert.ok(fs.existsSync(bundledNpm));
run(process.execPath, [bundledNpm, 'install', '--prefix', path.join(root, 'tools'), '--ignore-scripts', '--no-audit', '--no-fund', '--save-exact', `npm@${process.env.SELECTED_NPM}`], root, 0, 180000);
const npmCli = path.join(root, 'tools/node_modules/npm/bin/npm-cli.js');
assert.equal(run(process.execPath, [npmCli, '--version']).stdout.trim(), process.env.SELECTED_NPM);
const lock = JSON.parse(fs.readFileSync(path.join(repo, 'package-lock.json'), 'utf8'));
for (const [name, metadata] of Object.entries(lock.packages)) {
  if (metadata.resolved && !metadata.link) assert.equal(new URL(metadata.resolved).origin, 'https://registry.npmjs.org', name);
}
console.log(JSON.stringify({disabledLifecyclePackages: Object.entries(lock.packages).filter(([, p]) => p.hasInstallScript).map(([name]) => name)}));
run(process.execPath, [npmCli, 'ci', '--ignore-scripts', '--no-audit', '--no-fund'], repo, 0, 600000);
env.npm_config_offline = 'true';
env.npm_config_registry = 'http://127.0.0.1:9';
console.log('Runtime fixtures use npm offline mode and a loopback registry. No OS network-isolation claim.');
const helper = path.join(repo, 'packages/support/lib/npm.ts');
const fixed = fs.readFileSync(helper);
const original = run('git', ['show', `${base}:packages/support/lib/npm.ts`]).stdout;
assert.equal(hash(original), 'a98a4b7ab43ca69cd922aa78367c517bd099d188341a91c6d61af959ebab2a92');
try {
  fs.writeFileSync(helper, original);
  run(process.execPath, ['node_modules/typescript/bin/tsc', '-b'], repo, 0, 180000);
  const originalRoot = path.join(root, 'original');
  const control = run(process.execPath, [path.join(harness, 'verify-local-install.mjs'), repo, npmCli, originalRoot, 'original'], repo, 1);
  assert.match(control.stderr, /Local extension installation must not create a global intermediary/);
  const commands = JSON.parse(fs.readFileSync(path.join(originalRoot, 'commands.json'), 'utf8'));
  assert.equal(commands.at(-1).status, 0, 'Original CLI installation itself must succeed');
  console.log(JSON.stringify({originalSuccessfulInstallThenAssertionFailure: true, prefix: JSON.parse(fs.readFileSync(path.join(originalRoot, 'prefix-before-after.json'), 'utf8'))}));
} finally {
  fs.writeFileSync(helper, fixed);
  assert.equal(hash(fs.readFileSync(helper)), before['packages/support/lib/npm.ts']);
}
run(process.execPath, ['node_modules/typescript/bin/tsc', '-b'], repo, 0, 180000);
const selectedRunner = process.env.SELECTED_NPM === '10.0.0' ? 'verify-local-install-npm10.mjs' : 'verify-local-install.mjs';
run(process.execPath, [path.join(harness, selectedRunner), repo, npmCli, path.join(root, 'fixed'), 'fixed'], repo, 0, 120000);
const unitRoot = 'packages/appium/build/test/unit/extension';
const unitFiles = fs.readdirSync(path.join(repo, unitRoot)).filter((name) => name.endsWith('.spec.js')).sort().map((name) => `${unitRoot}/${name}`);
run(process.execPath, ['--test', '--enable-source-maps', '--test-timeout=5000', '--test-reporter=tap', 'packages/support/build/test/unit/npm.spec.js', ...unitFiles]);
run(process.execPath, ['node_modules/oxlint/bin/oxlint', '-c', 'oxlint.config.mjs', '.']);
run(process.execPath, ['node_modules/oxfmt/bin/oxfmt', '-c', 'oxfmt.config.mjs', '--check', 'packages/support/lib/npm.ts', 'packages/support/test/unit/npm.spec.ts']);
for (const name of sourcePaths) assert.equal(hash(fs.readFileSync(path.join(repo, name))), before[name], name);
run('git', ['diff', '--exit-code']);
assert.equal(run('git', ['status', '--porcelain']).stdout.trim(), '');
console.log(JSON.stringify({status: 'PASS', sourcePin, node: process.version, npm: process.env.SELECTED_NPM, sourceRestored: true, limits: 'Synthetic local driver/plugin packages; no device, real server, registry extension install, lifecycle execution or OS network-isolation claim. npm10 literal-percent limitation is separately preserved in Windows evidence.'}));
