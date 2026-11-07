const { test } = require('node:test');
const assert = require('node:assert/strict');
const IosWebKit = require('../server/lib/IosWebKit');
const CdpBridge = require('../server/lib/CdpBridge');

test('iOS discovers all devices, namespaces pages and pins the configured host', async () => {
  const calls = [];
  const ios = new IosWebKit({ fetchJson: async url => {
    calls.push(url.href);
    if (url.port === '9221') return [
      { deviceId: 'a', deviceName: 'iPhone', url: 'attacker.invalid:9222' },
      { deviceId: 'b', deviceName: 'iPad', url: 'localhost:9223' },
    ];
    return [{ id: 1, title: 'page', url: 'https://example.com', webSocketDebuggerUrl: 'ws://untrusted/devtools/page/1' }];
  } });
  const pages = await ios.discover();
  assert.equal(pages.length, 2);
  assert.notEqual(pages[0].id, pages[1].id);
  assert.ok(calls.every(url => url.startsWith('http://127.0.0.1:')));
  assert.equal(pages[0].frontend, 'webkit');
  assert.equal(pages[1].endpoint.port, '9223');
});

test('iOS selector, empty devices and proxy failure are actionable', async () => {
  const ios = new IosWebKit({ serial: 'b', fetchJson: async () => [{ deviceId: 'a', url: 'localhost:9222' }] });
  await assert.rejects(ios.discover(), /等待 iPhone/);
  ios.fetchJson = async () => { throw new Error('ECONNREFUSED'); };
  await assert.rejects(ios.discover(), /ios_webkit_debug_proxy/);
});

test('unified discovery keeps iOS pages when Android is disconnected', async t => {
  const bridge = new CdpBridge('http://localhost:9222', '1234567890123456', '/');
  t.after(() => bridge.close());
  bridge.ios = { discover: async () => [{ id: 'ios-page', frontend: 'webkit' }] };
  bridge.device = { ensure: async () => { throw new Error('USB disconnected'); }, close() {} };
  assert.equal((await bridge.discover())[0].frontend, 'webkit');
  bridge.iosOnly = true;
  assert.equal((await bridge.discover()).length, 1);
});

test('iOS HTTP discovery, frontend route and authenticated WebKit frames work end to end', async t => {
  const http = require('node:http');
  const { once } = require('node:events');
  const WebSocket = require('ws');
  const fs = require('node:fs/promises');
  const os = require('node:os');
  const path = require('node:path');
  const { start } = require('../server');
  const servers = [];
  const sockets = new Set();
  async function listen(server) {
    servers.push(server);
    server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    return `http://127.0.0.1:${server.address().port}`;
  }
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ios-frontend-test-'));
  await fs.writeFile(path.join(dir, 'Main.html'), '<html>WebKit fixture</html>');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    await fs.rm(dir, { recursive: true, force: true });
  });
  const upstream = http.createServer((req, res) => res.end(JSON.stringify([
    { id: 1, title: 'WKWebView', webSocketDebuggerUrl: 'ws://untrusted.invalid/devtools/page/1' },
  ])));
  const backend = new WebSocket.Server({ server: upstream });
  backend.on('connection', (ws, req) => {
    assert.equal(req.url, '/devtools/page/1');
    ws.on('message', data => ws.send(data.toString()));
  });
  const endpoint = await listen(upstream);
  const registry = await listen(http.createServer((req, res) => res.end(JSON.stringify([
    { deviceId: 'iphone', deviceName: 'iPhone', url: endpoint.replace('http://', '') },
  ]))));
  const server = http.createServer();
  await start({ server, basePath: '/test/', cdpToken: '1234567890123456', cdpIos: true, iosOnly: true, iosProxy: registry, webkitFrontend: dir });
  const origin = await listen(server);
  assert.equal((await fetch(origin + '/test/cdp/targets')).status, 401);
  assert.match(await (await fetch(origin + '/test/webkit/Main.html')).text(), /WebKit fixture/);
  const login = await fetch(origin + '/test/cdp/login', { method: 'POST', body: new URLSearchParams({ token: '1234567890123456' }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const { targets } = await (await fetch(origin + '/test/cdp/targets', { headers: { cookie } })).json();
  assert.equal(targets[0].frontend, 'webkit');
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/test/cdp/socket?id=' + encodeURIComponent(targets[0].id), { headers: { cookie } });
  await once(ws, 'open');
  const frame = JSON.stringify({ id: 42, method: 'Target.sendMessageToTarget', params: { targetId: 'page-1', message: '{"id":1,"method":"Runtime.enable"}' } });
  const message = once(ws, 'message'); ws.send(frame);
  assert.equal((await message)[0].toString(), frame);
  ws.terminate();
});
