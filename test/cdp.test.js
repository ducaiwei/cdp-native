const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const { once } = require('node:events');
const WebSocket = require('ws');
const { start } = require('../server');
const CdpBridge = require('../server/lib/CdpBridge');

const token = 'test-native-cdp-secret';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function fixture(t) {
  const upstream = http.createServer((req, res) => {
    if (req.url !== '/json/list') {
      res.writeHead(404).end();
      return;
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify([
      { id: 'page-1', type: 'page', title: '<test>', url: 'https://example.test', webSocketDebuggerUrl: 'ws://unreachable.invalid/devtools/page/page-1' },
      { id: 'worker-1', type: 'worker', webSocketDebuggerUrl: 'ws://unreachable.invalid/devtools/page/worker-1' },
    ]));
  });
  const backend = new WebSocket.Server({ server: upstream });
  backend.on('connection', ws => {
    ws.on('message', data => {
      const command = JSON.parse(data.toString());
      ws.send(JSON.stringify({ id: command.id, sessionId: command.sessionId, result: { method: command.method } }));
      if (command.method === 'Debugger.pause') ws.send(JSON.stringify({ method: 'Debugger.paused', params: { reason: 'other', callFrames: [] } }));
    });
  });
  const endpoint = await listen(upstream);
  const server = http.createServer();
  const connections = new Set();
  server.on('connection', socket => {
    connections.add(socket);
    socket.on('close', () => connections.delete(socket));
  });
  await start({ server, basePath: '/debug/', cdp: endpoint, cdpToken: token });
  const origin = await listen(server);
  t.after(async () => {
    for (const ws of backend.clients) ws.terminate();
    backend.close();
    for (const socket of connections) socket.destroy();
    await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  });
  const login = await fetch(`${origin}/debug/cdp/login`, { method: 'POST', body: new URLSearchParams({ token }) });
  assert.equal(login.status, 204);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  return { origin, cookie, backend, upstream, wsUrl: origin.replace('http:', 'ws:') + '/debug/cdp/socket?id=page-1' };
}

function rejectedSocket(url, headers) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.on('unexpected-response', (req, res) => {
      const status = res.statusCode;
      res.resume();
      req.destroy();
      resolve(status);
    });
    ws.on('error', () => {});
    ws.on('open', () => { ws.terminate(); reject(new Error('Unexpected successful upgrade')); });
  });
}

test('native CDP validates operator configuration', () => {
  assert.throws(() => new CdpBridge('file:///etc/passwd', token, '/'), /HTTP/);
  assert.throws(() => new CdpBridge('http://localhost:9222', '', '/'), /16 characters/);
});

test('CDP login, discovery and base path are isolated from injected targets', async t => {
  const f = await fixture(t);
  assert.equal((await fetch(f.origin + '/debug/')).status, 200);
  const page = await (await fetch(f.origin + '/debug/cdp/')).text();
  assert.match(page, /front_end\/inspector.html/);
  assert.equal((await fetch(f.origin + '/debug/cdp/targets')).status, 401);
  const bad = await fetch(f.origin + '/debug/cdp/login', { method: 'POST', body: 'token=wrong' });
  assert.equal(bad.status, 401);
  const crossSite = await fetch(f.origin + '/debug/cdp/login', { method: 'POST', headers: { Origin: 'https://other.test' }, body: new URLSearchParams({ token }) });
  assert.equal(crossSite.status, 403);
  const targets = await (await fetch(f.origin + '/debug/cdp/targets', { headers: { Cookie: f.cookie } })).json();
  assert.deepEqual(targets.targets, [{ id: 'page-1', title: '<test>', url: 'https://example.test' }]);
  assert.equal((await fetch(f.origin + '/debug/targets')).status, 404);
  assert.equal((await fetch(f.origin + '/debug/front_end/inspector.html')).status, 200);
});

test('CDP WebSocket rejects missing credentials, foreign origins and unknown targets', async t => {
  const f = await fixture(t);
  assert.equal(await rejectedSocket(f.wsUrl, {}), 401);
  assert.equal(await rejectedSocket(f.wsUrl, { Cookie: f.cookie, Origin: 'https://other.test' }), 401);
  assert.equal(await rejectedSocket(f.wsUrl.replace('page-1', 'missing'), { Cookie: f.cookie }), 404);
});

test('CDP relays commands, session IDs and pause events and closes upstream on disconnect', async t => {
  const f = await fixture(t);
  const ws = new WebSocket(f.wsUrl, { headers: { Cookie: f.cookie, Origin: f.origin } });
  await once(ws, 'open');
  t.after(() => ws.terminate());
  const messages = [];
  const received = new Promise(resolve => ws.on('message', data => {
    messages.push(JSON.parse(data.toString()));
    if (messages.length === 2) resolve();
  }));
  ws.send(JSON.stringify({ id: 42, sessionId: 'nested-session', method: 'Debugger.pause' }));
  await received;
  assert.equal(messages[0].id, 42);
  assert.equal(messages[0].sessionId, 'nested-session');
  assert.equal(messages[1].method, 'Debugger.paused');
  const upstream = [...f.backend.clients][0];
  const closed = once(upstream, 'close');
  ws.close();
  await closed;
});

test('upstream disconnect is propagated to DevTools', async t => {
  const f = await fixture(t);
  const ws = new WebSocket(f.wsUrl, { headers: { Cookie: f.cookie } });
  await once(ws, 'open');
  const closed = once(ws, 'close');
  [...f.backend.clients][0].close();
  const [code] = await closed;
  assert.equal(code, 1001);
});

test('discovery failures return a useful HTTP error and reject WebSocket upgrades', async t => {
  const f = await fixture(t);
  f.upstream.removeAllListeners('request');
  f.upstream.on('request', (req, res) => res.writeHead(503).end());
  const response = await fetch(f.origin + '/debug/cdp/targets', { headers: { Cookie: f.cookie } });
  assert.equal(response.status, 502);
  assert.match(await response.text(), /Cannot discover Chrome targets/);
  assert.equal(await rejectedSocket(f.wsUrl, { Cookie: f.cookie }), 502);
});

test('real Chrome: breakpoint, local variables, step over and resume through Chii', {
  skip: !process.env.CHII_TEST_CDP_URL,
  timeout: 20000,
}, async t => {
  const endpoint = process.env.CHII_TEST_CDP_URL;
  const created = await fetch(new URL('/json/new?about:blank', endpoint), { method: 'PUT' });
  const page = await created.json();
  t.after(() => fetch(new URL('/json/close/' + page.id, endpoint)));
  const server = http.createServer();
  await start({ server, cdp: endpoint, cdpToken: token });
  const origin = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const login = await fetch(origin + '/cdp/login', { method: 'POST', body: new URLSearchParams({ token }) });
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const ws = new WebSocket(origin.replace('http:', 'ws:') + '/cdp/socket?id=' + page.id, { headers: { Cookie: cookie } });
  await once(ws, 'open');
  t.after(() => ws.terminate());
  let sequence = 0;
  const pending = new Map();
  const events = new (require('node:events').EventEmitter)();
  ws.on('message', data => {
    const message = JSON.parse(data.toString());
    if (message.id) {
      const handler = pending.get(message.id);
      if (!handler) return;
      pending.delete(message.id);
      if (message.error) handler.reject(new Error(JSON.stringify(message.error)));
      else handler.resolve(message.result);
    } else events.emit(message.method, message.params);
  });
  const command = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
  });
  await command('Runtime.enable');
  await command('Debugger.enable');
  await command('Debugger.setBreakpointByUrl', { url: 'chii-cdp-test.js', lineNumber: 2 });
  const paused = once(events, 'Debugger.paused');
  const evaluation = command('Runtime.evaluate', {
    expression: '(function nativeCdpTest(){\n let value=40;\n value += 2;\n return value;\n})()\n//# sourceURL=chii-cdp-test.js',
  });
  const [pause] = await paused;
  assert.equal(pause.callFrames[0].location.lineNumber, 2);
  const before = await command('Debugger.evaluateOnCallFrame', { callFrameId: pause.callFrames[0].callFrameId, expression: 'value' });
  assert.equal(before.result.value, 40);
  const stepped = once(events, 'Debugger.paused');
  await command('Debugger.stepOver');
  const [next] = await stepped;
  const after = await command('Debugger.evaluateOnCallFrame', { callFrameId: next.callFrames[0].callFrameId, expression: 'value' });
  assert.equal(after.result.value, 42);
  await command('Debugger.resume');
  assert.equal((await evaluation).result.value, 42);
  const statementPaused = once(events, 'Debugger.paused');
  const statement = command('Runtime.evaluate', { expression: 'debugger; 7' });
  await statementPaused;
  await command('Debugger.resume');
  assert.equal((await statement).result.value, 7);
  const closed = once(ws, 'close');
  ws.close();
  await closed;
});
