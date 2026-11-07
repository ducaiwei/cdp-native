const http = require('node:http');
const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const Koa = require('koa');
const Router = require('koa-router');
const send = require('koa-send');
const CdpBridge = require('./lib/CdpBridge');
const AdbCdp = require('./lib/AdbCdp');
const HdcCdp = require('./lib/HdcCdp');
const DeviceCdp = require('./lib/DeviceCdp');
const IosWebKit = require('./lib/IosWebKit');

async function start({
  port = 8080, host = '127.0.0.1', server, basePath = '/',
  https: useHttps, sslCert, sslKey,
  cdp = process.env.CHII_CDP_URL,
  cdpToken = process.env.CHII_CDP_TOKEN,
  cdpAdb = process.env.CHII_CDP_ADB === '1',
  adbPath = process.env.CHII_ADB_PATH,
  adbSerial = process.env.CHII_ADB_SERIAL,
  adbPackage = process.env.CHII_ADB_PACKAGE,
  cdpHdc = process.env.CHII_CDP_HDC === '1',
  hdcPath = process.env.CHII_HDC_PATH,
  hdcSerial = process.env.CHII_HDC_SERIAL,
  hdcPackage = process.env.CHII_HDC_PACKAGE,
  cdpIos = false, iosOnly = false,
  iosProxy = process.env.CHII_IOS_PROXY || 'http://127.0.0.1:9221',
  iosSerial = process.env.CHII_IOS_SERIAL,
  webkitFrontend = process.env.CHII_WEBKIT_FRONTEND || path.resolve(__dirname, '../public/webkit'),
} = {}) {
  if (!basePath.startsWith('/')) throw new Error('basePath must start with /');
  if (!basePath.endsWith('/')) basePath += '/';
  const bridge = new CdpBridge(cdp || 'http://127.0.0.1:9223', cdpToken, basePath);
  if (cdpIos) {
    await fs.access(path.join(webkitFrontend, 'Main.html')).catch(() => {
      throw new Error('缺少 WebKit 前端，请运行 cdp-native setup:webkit，或通过 --webkit-frontend 指定已准备好的目录。');
    });
    bridge.ios = new IosWebKit({ url: iosProxy, serial: iosSerial });
    bridge.iosOnly = iosOnly;
  }
  const providers = [];
  if (cdpAdb) providers.push(new AdbCdp({ adb: adbPath, serial: adbSerial, packageName: adbPackage }));
  if (cdpHdc) providers.push(new HdcCdp({ hdc: hdcPath, serial: hdcSerial, packageName: hdcPackage }));
  if (providers.length) bridge.device = providers.length === 1 ? providers[0] : new DeviceCdp(providers);
  const app = new Koa();
  const router = new Router();
  bridge.routes(router);
  router.get(basePath, ctx => ctx.redirect(`${basePath}cdp/`));
  router.get(`${basePath}front_end/:staticPath(.*)`, async ctx => {
    await send(ctx, ctx.params.staticPath, { root: path.resolve(__dirname, '../public/front_end'), maxage: 7200000 });
  });
  if (cdpIos) router.get(`${basePath}webkit/:staticPath(.*)`, async ctx => {
    await send(ctx, ctx.params.staticPath, { root: path.resolve(webkitFrontend), maxage: 0 });
  });
  app.use(router.routes()).use(router.allowedMethods());
  const external = Boolean(server);
  if (!server) server = useHttps
    ? https.createServer({ cert: await fs.readFile(sslCert), key: await fs.readFile(sslKey) })
    : http.createServer();
  server.on('request', app.callback());
  server.on('close', () => bridge.close());
  server.on('upgrade', (request, socket, head) => {
    if (bridge.handles(request.url)) bridge.upgrade(request, socket, head).catch(() => socket.destroy());
    else socket.destroy();
  });
  if (!external) await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });
  return server;
}
module.exports = { start };
