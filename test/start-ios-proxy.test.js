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
