import assert from 'node:assert/strict';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {describe, it} from 'node:test';
import type {TestContext} from 'node:test';

import {INSTALL_LOCKFILE_RELATIVE_PATH, NPM, resolveFrom} from '../../lib/npm';
import * as system from '../../lib/system';

describe('npm', function () {
  describe('resolveFrom()', function () {
    const supportRoot = path.join(__dirname, '..', '..');

    it('should resolve a package path from a directory', async function () {
      const resolved = await resolveFrom(supportRoot, 'semver/package.json');
      assert.match(resolved, /semver[/\\]package\.json$/);
    });

    it('should reject when the module cannot be resolved', async function () {
      await assert.rejects(resolveFrom(supportRoot, 'nonexistent-appium-package-xyz/package.json'));
    });
  });

  describe('installPackage()', function () {
    for (const installType of ['local', 'npm', 'git', 'github', 'tarball', undefined]) {
      it(`should install ${installType ?? 'default'} packages with the existing receipt and lock`, async function (t) {
        t.mock.method(system, 'isWindows', () => false);
        const {cwd, packagePath, pkg} = await installationFixture(t);
        const npm = new NPM();
        const installSpec = installType === 'local' ? packagePath : '@fixture/extension@1.0.0';
        const exec = t.mock.method(npm, 'exec', async () => ({stdout: '', stderr: '', code: 0}));

        assert.deepStrictEqual(await npm.installPackage(cwd, installSpec, {pkgName: pkg.name, installType}), {
          installPath: packagePath,
          pkg,
        });

        const [command, args, options] = exec.mock.calls[0].arguments;
        assert.strictEqual(exec.mock.callCount(), 1);
        assert.strictEqual(command, 'install');
        assert.deepStrictEqual(args, [
          '--save-dev',
          '--no-progress',
          '--no-audit',
          ...(installType === 'local' ? ['--install-links=false'] : []),
          installSpec,
        ]);
        assert.deepStrictEqual(options, {
          cwd,
          json: true,
          lockFile: path.join(cwd, INSTALL_LOCKFILE_RELATIVE_PATH),
        });
      });
    }

    it('should preserve standalone-home options for a local install', async function (t) {
      t.mock.method(system, 'isWindows', () => false);
      const {cwd, packagePath, pkg} = await installationFixture(t, false);
      const npm = new NPM();
      const exec = t.mock.method(npm, 'exec', async () => ({stdout: '', stderr: '', code: 0}));
      await npm.installPackage(cwd, packagePath, {pkgName: pkg.name, installType: 'local'});
      assert.deepStrictEqual(exec.mock.calls[0].arguments[1], [
        '--save-dev',
        '--no-progress',
        '--no-audit',
        ...(process.env.APPIUM_OMIT_PEER_DEPS ? ['--omit=peer'] : []),
        '--save-exact',
        '--global-style',
        '--no-package-lock',
        '--install-links=false',
        packagePath,
      ]);
    });

    for (const [source, expected] of [
      [String.raw`F:\source packages\local driver`, String.raw`^^^"F:\source^^^ packages\local^^^ driver^^^"`],
      [
        'F:\\fixtures\\a&b (test) %USERPROFILE%!^\\',
        String.raw`^^^"F:\fixtures\a^^^&b^^^ ^^^(test^^^)^^^ ^^^%USERPROFILE^^^%^^^!^^^^\\^^^"`,
      ],
    ]) {
      it(`should preserve the literal Windows local path ${source}`, async function (t) {
        const {cwd, pkg} = await installationFixture(t);
        t.mock.method(system, 'isWindows', () => true);
        const npm = new NPM();
        const exec = t.mock.method(npm, 'exec', async () => ({stdout: '', stderr: '', code: 0}));
        await npm.installPackage(cwd, source, {pkgName: pkg.name, installType: 'local'});
        const args = exec.mock.calls[0].arguments[1];
        assert.ok(args);
        assert.strictEqual(args.at(-1), expected);
      });
    }

    it('should propagate an npm installation error', async function (t) {
      const {cwd, packagePath, pkg} = await installationFixture(t);
      const npm = new NPM();
      t.mock.method(npm, 'exec', async () => ({stdout: '', stderr: '', code: 0, json: {error: 'install failed'}}));
      await assert.rejects(
        npm.installPackage(cwd, packagePath, {pkgName: pkg.name, installType: 'local'}),
        /install failed/,
      );
    });
  });

  describe('uninstallPackage()', function () {
    it('should disable audit while retaining the install lock', async function (t) {
      const npm = new NPM();
      const cwd = path.resolve('appium-home');
      const exec = t.mock.method(npm, 'exec', async () => ({stdout: '', stderr: '', code: 0}));

      await npm.uninstallPackage(cwd, '@appium/fake-driver');

      assert.strictEqual(exec.mock.callCount(), 1);
      const [command, args, options] = exec.mock.calls[0].arguments;
      assert.strictEqual(command, 'uninstall');
      assert.deepStrictEqual(args, ['@appium/fake-driver', '--no-audit']);
      assert.ok(options);
      assert.strictEqual(options.cwd, cwd);
      assert.ok(options.lockFile);
    });
  });

  describe('getLatestSafeUpgradeFromVersions()', function () {
    const versions1 = [
      '0.1.0',
      '0.1.1',
      '0.2.0',
      '0.2.5',
      '1.0.0',
      '1.0.1',
      '1.1.5',
      '1.2.7',
      '2.0.0',
      '1.2.8-beta',
      '1.2.9-alpha',
      '1.3.0-rc',
      '2.0.1-beta',
    ];
    const npm = new NPM();
    it('should get the latest minor upgrade in a list of versions', function () {
      assert.strictEqual(npm.getLatestSafeUpgradeFromVersions('0.1.0', versions1), '0.2.5');
      assert.strictEqual(npm.getLatestSafeUpgradeFromVersions('1.0.0', versions1), '1.2.7');
      assert.strictEqual(npm.getLatestSafeUpgradeFromVersions('0.2.0', versions1), '0.2.5');
    });
    it('should throw if the current version cannot be parsed', function () {
      assert.throws(() => {
        npm.getLatestSafeUpgradeFromVersions('', versions1);
      });
    });
    it('should ignore an error if one of versions cannot be parsed', function () {
      assert.strictEqual(npm.getLatestSafeUpgradeFromVersions('0.1.0', ['', '0.2.0']), '0.2.0');
    });
    it('should return null if no newer version is found', function () {
      assert.strictEqual(npm.getLatestSafeUpgradeFromVersions('10', versions1), null);
    });
  });
});

async function installationFixture(t: TestContext, appiumDependency = true) {
  const temporaryRoot = path.resolve(tmpdir());
  const cwd = await mkdtemp(path.join(temporaryRoot, 'appium-npm-install-'));
  t.after(async () => {
    const target = path.resolve(cwd);
    assert.strictEqual(path.dirname(target), temporaryRoot);
    assert.ok(path.basename(target).startsWith('appium-npm-install-'));
    await rm(target, {recursive: true, force: true});
  });
  await writeFile(
    path.join(cwd, 'package.json'),
    JSON.stringify(appiumDependency ? {devDependencies: {appium: '^3.0.0'}} : {}),
  );
  const packagePath = path.join(cwd, 'node_modules', '@fixture', 'extension');
  const pkg = {name: '@fixture/extension', version: '1.0.0'};
  await mkdir(packagePath, {recursive: true});
  await writeFile(path.join(packagePath, 'package.json'), JSON.stringify(pkg));
  return {cwd, packagePath, pkg};
}
