import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

// This runner executes the compiled Appium CLI and real npm, never npm stubs.
// All npm state and synthetic packages are confined to an explicitly supplied new directory.
const [repoArgument, npmArgument, rootArgument, mode = 'fixed'] = process.argv.slice(2);
assert.ok(repoArgument && npmArgument && rootArgument, 'usage: node verify-local-install.mjs REPO NPM_CLI NEW_ROOT [original|fixed]');
assert.ok(['original', 'fixed'].includes(mode));
const repo = fs.realpathSync(repoArgument);
const npmCli = fs.realpathSync(npmArgument);
const root = path.resolve(rootArgument);
assert.ok(!fs.existsSync(root), 'Use a new fixture root; never overwrite existing data');
if (process.platform === 'win32') {
  assert.match(root, /^[FE]:[\\/]/i, 'Windows fixture data must be on F: or E:');
}
assert.ok(!repo.startsWith(root + path.sep), 'Fixture root must not contain the repository');
fs.mkdirSync(root, {recursive: true});
const childHome = path.join(root, 'user');
const prefix = path.join(root, 'global-prefix');
const cache = path.join(root, 'npm-cache');
const appiumHome = path.join(root, 'appium-home');
const temporary = path.join(root, 'tmp');
const shim = path.join(root, 'bin');
for (const directory of [childHome, prefix, cache, appiumHome, temporary, shim]) {
  fs.mkdirSync(directory);
}
if (process.platform !== 'win32') {
  // Match npm's Unix global-prefix layout before taking the unchanged-prefix snapshot.
  fs.mkdirSync(path.join(prefix, 'lib', 'node_modules'), {recursive: true});
}
const userConfig = path.join(root, 'npm-user.rc');
const globalConfig = path.join(root, 'npm-global.rc');
fs.writeFileSync(userConfig, '');
fs.writeFileSync(globalConfig, '');
fs.writeFileSync(path.join(prefix, 'sentinel.txt'), 'owned fixture prefix\n');

const env = {};
for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT']) {
  if (process.env[key]) env[key] = process.env[key];
}
Object.assign(env, {
  PATH: [shim, path.dirname(process.execPath), ...(process.platform === 'win32' ? [path.join(process.env.SystemRoot, 'System32')] : ['/usr/bin', '/bin'])].join(path.delimiter),
  HOME: childHome, USERPROFILE: childHome, TEMP: temporary, TMP: temporary, TMPDIR: temporary,
  APPDATA: path.join(childHome, 'AppData'), LOCALAPPDATA: path.join(childHome, 'LocalAppData'),
  APPIUM_HOME: appiumHome, APPIUM_OMIT_PEER_DEPS: '1',
  npm_config_prefix: prefix, npm_config_cache: cache,
  npm_config_userconfig: userConfig, npm_config_globalconfig: globalConfig,
  npm_config_registry: 'http://127.0.0.1:9', npm_config_offline: 'true',
  npm_config_ignore_scripts: 'true', npm_config_audit: 'false', npm_config_fund: 'false',
  npm_config_update_notifier: 'false', npm_config_fetch_retries: '0',
  npm_config_install_links: 'true', NO_COLOR: '1', CI: '1',
});
const quoteSh = (value) => "'" + value.replaceAll("'", "'\\''") + "'";
if (process.platform === 'win32') {
  assert.ok(!/[\r\n%]/.test(process.execPath + npmCli));
  fs.writeFileSync(path.join(shim, 'npm.cmd'), `@echo off\r\n"${process.execPath}" "${npmCli}" %*\r\n`);
} else {
  fs.writeFileSync(path.join(shim, 'npm'), `#!/bin/sh\nexec ${quoteSh(process.execPath)} ${quoteSh(npmCli)} "$@"\n`, {mode: 0o755});
}

const log = [];
function command(args, cwd = root, expected = 0) {
  const result = spawnSync(process.execPath, args, {cwd, env, encoding: 'utf8', timeout: 60000, maxBuffer: 2 * 1024 * 1024});
  log.push({args, cwd, status: result.status, signal: result.signal, stdout: result.stdout, stderr: result.stderr});
  fs.writeFileSync(path.join(root, 'commands.json'), JSON.stringify(log, null, 2));
  assert.ifError(result.error);
  assert.equal(result.signal, null);
  assert.equal(result.status, expected, `${JSON.stringify(args)}\n${result.stdout}\n${result.stderr}`);
  return result.stdout.trim();
}
function writePackage(directory, json, source) {
  fs.mkdirSync(directory, {recursive: true});
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify(json, null, 2));
  fs.writeFileSync(path.join(directory, 'index.js'), source);
}
function prefixSnapshot(directory = prefix, relative = '') {
  const entries = [];
  for (const name of fs.readdirSync(directory).sort()) {
    const full = path.join(directory, name);
    const sub = path.join(relative, name);
    const stat = fs.lstatSync(full);
    if (stat.isSymbolicLink()) entries.push([sub, 'link', fs.readlinkSync(full)]);
    else if (stat.isDirectory()) entries.push([sub, 'directory'], ...prefixSnapshot(full, sub));
    else entries.push([sub, createHash('sha256').update(fs.readFileSync(full)).digest('hex')]);
  }
  return entries;
}
const cli = path.join(repo, 'packages', 'appium', 'index.js');
const fromRepo = createRequire(path.join(repo, 'package.json'));
const yaml = fromRepo('yaml');
const initialPrefix = prefixSnapshot();
const npmVersion = command([npmCli, '--version']);
const checkedPrefix = command([npmCli, 'prefix', '--global']);
assert.equal(path.resolve(checkedPrefix), prefix, 'Real npm must use only the disposable global prefix');
const manifestPath = path.join(appiumHome, 'node_modules', '.cache', 'appium', 'extensions.yaml');
function readManifest() { return yaml.parse(fs.readFileSync(manifestPath, 'utf8')); }
function appium(args, expected = 0) { return command([cli, ...args, '--json'], root, expected); }
function readModule(name) {
  return JSON.parse(command(['-e', `const {createRequire}=require('node:module');const r=createRequire(process.argv[1]);console.log(JSON.stringify(r(process.argv[2])));`, path.join(appiumHome, 'package.json'), name]));
}
function assertUnchangedPrefix() {
  assert.deepEqual(prefixSnapshot(), initialPrefix, 'Local extension installation must not create a global intermediary');
}

// The original source control uses a plain path so an unrelated spaced-path issue cannot mask it.
if (mode === 'original') {
  const source = path.join(root, 'original-driver');
  writePackage(source, {name: 'fixture-original-driver', version: '1.0.0', main: 'index.js', appium: {driverName: 'fixture-original', automationName: 'Fixture', platformNames: ['Fixture'], mainClass: 'FixtureDriver'}}, 'module.exports = {FixtureDriver: class FixtureDriver {}};\n');
  env.npm_config_install_links = 'false';
  appium(['driver', 'install', '--source', 'local', source]);
  fs.writeFileSync(path.join(root, 'prefix-before-after.json'), JSON.stringify({before: initialPrefix, after: prefixSnapshot()}, null, 2));
  assertUnchangedPrefix();
  throw new Error('Original control unexpectedly passed');
}

const fixtureRoot = path.join(root, 'source packages');
const leaf = path.join(fixtureRoot, 'leaf');
const dependency = path.join(fixtureRoot, 'dependency');
const devDependency = path.join(fixtureRoot, 'dev-dependency');
writePackage(leaf, {name: 'fixture-leaf', version: '1.0.0', main: 'index.js'}, "module.exports = 'leaf';\n");
writePackage(dependency, {name: 'fixture-dependency', version: '1.0.0', main: 'index.js', dependencies: {'fixture-leaf': 'file:../leaf'}}, "module.exports = 'runtime:' + require('fixture-leaf');\n");
writePackage(devDependency, {name: 'fixture-dev-dependency', version: '1.0.0', main: 'index.js'}, "module.exports = 'development';\n");
const prepare = (directory) => command([npmCli, 'install', '--offline', '--ignore-scripts', '--install-links=false', '--no-audit', '--no-fund', '--no-package-lock'], directory);
prepare(dependency);
const assertions = [];
for (const type of ['driver', 'plugin']) {
  const extensionName = `fixture-${type}`;
  const packageName = type === 'driver' ? '@fixture/local-driver' : 'fixture-local-plugin';
  // Literal Windows-valid shell characters; these are folder names, never executable payloads.
  const source = path.join(fixtureRoot, type === 'plugin' ? 'local plugin & (literal) %USERPROFILE%!^' : 'local driver');
  const className = type === 'driver' ? 'FixtureDriver' : 'FixturePlugin';
  const metadata = type === 'driver'
    ? {driverName: extensionName, automationName: 'Fixture', platformNames: ['Fixture'], mainClass: className}
    : {pluginName: extensionName, mainClass: className};
  writePackage(source, {
    name: packageName, version: '1.0.0', main: 'index.js', appium: metadata,
    dependencies: {'fixture-dependency': 'file:../dependency'},
    devDependencies: {'fixture-dev-dependency': 'file:../dev-dependency'},
  }, `module.exports = {${className}: class ${className} {}, marker:'before', dependency:require('fixture-dependency'), development:require('fixture-dev-dependency')};\n`);
  prepare(source);
  const installed = JSON.parse(appium([type, 'install', '--source', 'local', source]));
  assert.equal(installed[extensionName].pkgName, packageName);
  assert.equal(installed[extensionName].installType, 'local');
  assert.equal(fs.realpathSync(installed[extensionName].installPath), fs.realpathSync(source));
  const link = path.join(appiumHome, 'node_modules', ...packageName.split('/'));
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true, 'Installed package must remain a live link');
  assert.equal(fs.realpathSync(link), fs.realpathSync(source));
  const record = readManifest()[`${type}s`][extensionName];
  assert.equal(record.pkgName, packageName);
  assert.equal(record.installType, 'local');
  assert.equal(fs.realpathSync(record.installPath), fs.realpathSync(source));
  const listed = JSON.parse(appium([type, 'list', '--installed']));
  assert.equal(listed[extensionName].installed, true);
  assert.equal(readModule(packageName).dependency, 'runtime:leaf');
  assert.equal(readModule(packageName).development, 'development');
  fs.appendFileSync(path.join(source, 'index.js'), "module.exports.marker = 'after';\n");
  assert.equal(readModule(packageName).marker, 'after', 'Source edits must be visible without reinstall');
  assertUnchangedPrefix();
  appium([type, 'uninstall', extensionName]);
  assert.equal(fs.existsSync(link), false);
  assert.equal(readManifest()[`${type}s`]?.[extensionName], undefined);
  assert.equal(fs.existsSync(path.join(source, 'index.js')), true, 'Uninstall must preserve source');
  appium([type, 'install', '--source', 'local', source]);
  assert.equal(readModule(packageName).marker, 'after');
  appium([type, 'uninstall', extensionName]);
  assertUnchangedPrefix();
  assertions.push({type, packageName, checks: ['CLI install', 'live direct link', 'receipt', 'manifest', 'list', 'prepared transitive and dev dependencies', 'source edit', 'uninstall preserves source', 'reinstall', 'global prefix unchanged', 'ambient install-links=true overridden']});
}
const result = {mode, node: process.version, npm: npmVersion, platform: process.platform, arch: process.arch, root, assertions, prefixUnchanged: true, limits: 'Synthetic local packages; no real device/server, registry package install, lifecycle execution or cloud service. npm offline mode plus loopback-only registry configured; OS network isolation is not asserted by this runner.'};
fs.writeFileSync(path.join(root, 'result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
