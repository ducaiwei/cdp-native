const { test } = require('node:test');
const assert = require('node:assert/strict');
const setup = require('../scripts/setup-ios-proxy');
const prepare = require('../server/lib/prepareIosProxy');

test('arm64 setup reuses installed proxy and passes platform and architecture', async () => {
  assert.equal(await setup({ platform: 'darwin', arch: 'arm64',
    prepare: async options => {
      assert.deepEqual(options, { download: false, platform: 'darwin', arch: 'arm64' });
      return '/proxy';
    }, run() { assert.fail('unexpected installation'); },
  }), '/proxy');
});

test('arm64 setup installs missing proxy and verifies installation', async () => {
  let checks = 0;
  const calls = [];
  assert.equal(await setup({ platform: 'darwin', arch: 'arm64',
    prepare: async () => { if (++checks === 1) throw new Error('missing'); return '/proxy'; },
    run: (file, args) => calls.push([file, args]), log() {},
  }), '/proxy');
  assert.equal(checks, 2);
  assert.deepEqual(calls, [
    ['/opt/homebrew/bin/brew', ['--version']],
    ['/opt/homebrew/bin/brew', ['install', 'ios-webkit-debug-proxy']],
  ]);
});

for (const [arch, prefixes, hint] of [
  ['arm64', ['/opt/homebrew', '/usr/local'], /setup:webkit/],
  ['x64', ['/usr/local', '/opt/homebrew'], /brew install ios-webkit-debug-proxy/],
]) {
  test(`darwin/${arch}: detection validates binaries and falls back across Homebrew locations`, async () => {
    for (const target of prefixes) {
      const calls = [];
      const executable = `${target}/bin/ios_webkit_debug_proxy`;
      assert.equal(await prepare({ platform: 'darwin', arch, iosProxyPath: '', iosProxyManifest: '',
        run: async file => {
          calls.push(file);
          if (file !== executable) throw new Error('missing or incompatible');
          return { stdout: 'ios-webkit-debug-proxy 1.9.1' };
        },
      }), executable);
      assert.deepEqual(calls, ['ios_webkit_debug_proxy', ...prefixes.slice(0, prefixes.indexOf(target) + 1).map(prefix => `${prefix}/bin/ios_webkit_debug_proxy`)]);
    }
  });

  test(`darwin/${arch}: missing proxy reports installation instructions without downloading`, async () => {
    for (const download of [true, false]) {
      await assert.rejects(prepare({ platform: 'darwin', arch, download,
        iosProxyPath: '', iosProxyManifest: '', sources: {},
        run: async () => ({ stdout: 'unrelated program' }),
        fetchArchive() { assert.fail('unexpected download'); },
      }), hint);
    }
  });
}
