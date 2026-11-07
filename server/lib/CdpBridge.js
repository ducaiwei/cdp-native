const crypto = require('crypto');
const WebSocket = require('ws');
const readTpl = require('./readTpl');

const MAX_BUFFER = 8 * 1024 * 1024;

// Only the operator-configured endpoint is contacted, never a URL supplied by a visitor.
module.exports = class CdpBridge {
  constructor(endpoint, token, basePath) {
    this.endpoint = new URL(endpoint);
    if (!['http:', 'https:'].includes(this.endpoint.protocol) || this.endpoint.username || this.endpoint.password) {
      throw new Error('CDP endpoint must be an HTTP(S) URL without credentials');
    }
    if (!token || token.length < 16) throw new Error('CHII_CDP_TOKEN must contain at least 16 characters');
    this.endpoint.pathname = this.endpoint.pathname.replace(/\/?$/, '/');
    this.endpoint.search = '';
    this.endpoint.hash = '';
    this.path = `${basePath}cdp/`;
    this.basePath = basePath;
    this.token = token;
    this.session = crypto.createHmac('sha256', token).update(`chii-cdp:${this.path}`).digest('hex');
    this.cookie = `chii_cdp_${crypto.createHash('sha256').update(this.path).digest('hex').slice(0, 8)}`;
    this.wss = new WebSocket.Server({ noServer: true, maxPayload: 32 * 1024 * 1024 });
  }

  authenticated(headers) {
    return (headers.cookie || '').split(';').some(part => {
      const [name, value] = part.trim().split('=');
      return name === this.cookie && equal(value || '', this.session);
    });
  }

  sameOrigin(headers) {
    if (!headers.origin) return true;
    try {
      return new URL(headers.origin).host === headers.host;
    } catch {
      return false;
    }
  }

  routes(router) {
    router.get(this.path, async ctx => {
      ctx.set('Cache-Control', 'no-store');
      ctx.set('X-Frame-Options', 'DENY');
      ctx.body = (await readTpl('cdp'))({ basePath: this.basePath });
    });
    router.post(`${this.path}login`, async ctx => {
      ctx.set('Cache-Control', 'no-store');
      if (!this.sameOrigin(ctx.headers)) return ctx.throw(403);
      let body = '';
      for await (const chunk of ctx.req) {
        body += chunk.toString();
        if (body.length > 4096) return ctx.throw(413);
      }
      const token = new URLSearchParams(body).get('token') || '';
      if (!equal(token, this.token)) return ctx.throw(401, 'Invalid CDP token');
      // The browser also sends this cookie on the DevTools WebSocket handshake.
      const secure = ctx.secure || ctx.get('x-forwarded-proto') === 'https';
      ctx.set('Set-Cookie', `${this.cookie}=${this.session}; Path=${this.path}; HttpOnly; SameSite=Strict${secure ? '; Secure' : ''}`);
      ctx.status = 204;
    });
    router.get(`${this.path}targets`, async ctx => {
      ctx.set('Cache-Control', 'no-store');
      if (!this.authenticated(ctx.headers)) return ctx.throw(401, 'CDP login required');
      try {
        ctx.body = { targets: (await this.discover()).map(({ id, title, url, process, frontend }) => ({ id, title, url, process, frontend })) };
      } catch (error) {
        ctx.status = 502;
        ctx.body = { error: this.device || this.adb || this.ios ? error.message : 'Cannot discover Chrome targets. Check CHII_CDP_URL and the Chrome debugging port.' };
      }
    });
  }

  async discover() {
    if (!this.ios) return this.discoverCdp();
    const sources = [this.ios.discover()];
    if (!this.iosOnly) sources.push(this.discoverCdp());
    const results = await Promise.allSettled(sources);
    if (results.every(result => result.status === 'rejected')) {
      throw new Error(results.map(result => result.reason.message).join('\n'));
    }
    return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  }

  async discoverCdp() {
    const device = this.device || this.adb;
    const discovered = device ? await device.ensure() : this.endpoint;
    const endpoints = Array.isArray(discovered) ? discovered : [discovered];
    const results = await Promise.allSettled(endpoints.map(async endpoint => {
      const response = await fetch(new URL('json/list', endpoint), {
        signal: AbortSignal.timeout(5000), redirect: 'error',
      });
      if (!response.ok) throw new Error('CDP discovery failed');
      const targets = await response.json();
      if (!Array.isArray(targets)) throw new Error('Invalid CDP target list');
      return targets.filter(target => target.type === 'page' && typeof target.id === 'string' && target.webSocketDebuggerUrl)
        .map(target => ({ ...target, endpoint, process: endpoint.process,
          id: endpoint.process ? JSON.stringify([endpoint.process, target.id]) : target.id }));
    }));
    if (results.every(result => result.status === 'rejected')) throw results[0].reason;
    return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  }

  handles(requestUrl) {
    return new URL(requestUrl, 'http://localhost').pathname.startsWith(this.path);
  }

  async upgrade(request, socket, head) {
    const url = new URL(request.url, 'http://localhost');
    if (url.pathname !== `${this.path}socket`) return reject(socket, 404);
    if (!this.authenticated(request.headers) || !this.sameOrigin(request.headers)) return reject(socket, 401);
    let target;
    try {
      target = (await this.discover()).find(item => item.id === url.searchParams.get('id'));
    } catch {
      return reject(socket, 502);
    }
    if (!target) return reject(socket, 404);
    if (socket.destroyed) return;

    const advertised = new URL(target.webSocketDebuggerUrl);
    if (!['ws:', 'wss:'].includes(advertised.protocol)) return reject(socket, 502);
    const upstreamUrl = new URL(target.endpoint);
    upstreamUrl.protocol = target.endpoint.protocol === 'https:' ? 'wss:' : 'ws:';
    upstreamUrl.pathname = advertised.pathname;
    upstreamUrl.search = advertised.search;
    const upstream = new WebSocket(upstreamUrl, {
      handshakeTimeout: 5000,
      maxPayload: 32 * 1024 * 1024,
      followRedirects: false,
      rejectUnauthorized: true,
    });
    let client;
    const stop = () => upstream.terminate();
    socket.on('close', stop);
    upstream.on('error', () => {
      if (client) client.close(1011, 'CDP upstream unavailable');
      else reject(socket, 502);
    });
    upstream.on('close', () => {
      if (client) client.close(1001, 'CDP upstream closed');
      else socket.destroy();
    });
    upstream.on('open', () => {
      if (socket.destroyed) return upstream.terminate();
      this.wss.handleUpgrade(request, socket, head, ws => {
        client = ws;
        // Raw CDP frames preserve request IDs, session IDs, and debugger events.
        ws.on('message', (data, binary) => relay(upstream, data, binary));
        upstream.on('message', (data, binary) => relay(ws, data, binary));
        ws.on('error', stop);
        ws.on('close', stop);
      });
    });
  }

  close() {
    if (this.device) this.device.close();
    if (this.adb) this.adb.close();
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
};

function equal(a, b) {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function reject(socket, status) {
  if (!socket.destroyed) socket.end(`HTTP/1.1 ${status} Error\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function relay(socket, data, binary) {
  if (socket.readyState !== WebSocket.OPEN) return;
  if (socket.bufferedAmount > MAX_BUFFER) return socket.close(1013, 'CDP client too slow');
  socket.send(data, { binary }, error => {
    if (error) socket.terminate();
  });
}
