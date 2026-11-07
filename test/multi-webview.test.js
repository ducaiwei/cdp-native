const { test } = require('node:test');
const assert = require('node:assert/strict');
const CdpBridge = require('../server/lib/CdpBridge');

test('multiple WebViews with identical page IDs keep distinct identities and upstreams', async t => {
  const endpoints = [32001, 32002].map((port, i) => {
    const url = new URL(`http://127.0.0.1:${port}/`);
    url.process = `webview_devtools_remote_${i + 10}`;
    return url;
  });
  t.mock.method(globalThis, 'fetch', async url => ({ ok: true, json: async () => [
    { id: 'same', type: 'page', title: url.port, webSocketDebuggerUrl: 'ws://untrusted/devtools/page/same' },
  ] }));
  const bridge = new CdpBridge('http://localhost:9222', '1234567890123456', '/');
  bridge.device = { ensure: async () => endpoints, close() {} };
  t.after(() => bridge.close());
  const targets = await bridge.discover();
  assert.equal(targets.length, 2);
  assert.notEqual(targets[0].id, targets[1].id);
  assert.equal(targets[0].endpoint, endpoints[0]);
  assert.equal(targets[1].endpoint, endpoints[1]);
  assert.equal(targets[1].process, 'webview_devtools_remote_11');
});
