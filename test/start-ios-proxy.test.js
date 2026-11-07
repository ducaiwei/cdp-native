const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const start = require('../server/lib/startIosProxy');
const refused = () => { throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }); };
const unexpected = () => { throw new Error('unexpected invocation'); };
function child() {
  const process = new EventEmitter();
  Object.assign(process, { exitCode: null, signalCode: null, kills: 0, kill() { this.kills++; } });
  return process;
}

test('existing proxy is reused without preparing, spawning or terminating it', async () => {
  const proxy = await start({}, { fetchJson: async () => [], prepare: unexpected, launch: unexpected });
  proxy.close();
  assert.equal(proxy.url, 'http://127.0.0.1:9221');
});

test('occupied non-proxy port never starts another service', async () => {
  await assert.rejects(start({}, { fetchJson: async () => ({}), prepare: unexpected }), /不是 iOS/);
});

test('managed proxy waits for readiness and close is idempotent', async () => {
  const process = child();
  let probes = 0;
  const proxy = await start({}, {
    fetchJson: async () => { if (++probes < 4) return refused(); return []; },
    prepare: async () => '/proxy',
    launch: (file, args) => { assert.equal(file, '/proxy'); assert.ok(args.includes('--no-frontend')); return process; },
    log() {},
  });
  proxy.close(); proxy.close();
  assert.equal(process.kills, 1);
});

test('startup timeout and spawn error clean up the owned process', async () => {
  for (const fails of [false, true]) {
    const process = child();
    await assert.rejects(start({}, {
      fetchJson: async () => refused(), prepare: async () => '/proxy', timeout: 20,
      launch: () => {
        if (fails) queueMicrotask(() => process.emit('error', new Error('ENOENT')));
        return process;
      }, log() {},
    }), fails ? /ENOENT|超时/ : /超时/);
    assert.equal(process.kills, 1);
  }
});

test('arm64 startup installs a missing proxy even when frontend is already prepared', async () => {
  let probes = 0;
  let installs = 0;
  const process = child();
  const proxy = await start({ platform: 'darwin', arch: 'arm64' }, {
    prepare: async () => { throw Object.assign(new Error('missing'), { code: 'IOS_PROXY_NOT_INSTALLED' }); },
    install: async options => { installs++; assert.equal(options.arch, 'arm64'); return '/installed/proxy'; },
    fetchJson: async () => { if (++probes <= 2) return refused(); return []; },
    launch: file => { assert.equal(file, '/installed/proxy'); return process; }, log() {},
  });
  proxy.close();
  assert.equal(installs, 1);
  assert.equal(process.kills, 1);
});

test('startup respects download opt-out, custom configuration and other architectures', async () => {
  for (const overrides of [{ download: false }, { iosProxyPath: '/custom' }, { iosProxyManifest: '/manifest' }, { arch: 'x64' }]) {
    await assert.rejects(start({ platform: 'darwin', arch: 'arm64', ...overrides }, {
      prepare: async () => { throw Object.assign(new Error('missing'), { code: 'IOS_PROXY_NOT_INSTALLED' }); },
      install: unexpected, launch: unexpected, fetchJson: async () => refused(),
    }), /missing/);
  }
  await assert.rejects(start({ platform: 'darwin', arch: 'arm64' }, {
    prepare: async () => { throw new Error('invalid manifest'); },
    install: unexpected, launch: unexpected, fetchJson: async () => refused(),
  }), /invalid manifest/);
});
