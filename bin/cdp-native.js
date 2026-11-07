#!/usr/bin/env node
const { Command } = require('commander');
const crypto = require('node:crypto');
const http = require('node:http');
const { execFile } = require('node:child_process');
const prepareDeviceTools = require('../server/lib/prepareDeviceTools');
const server = require('../server');
const startIosProxy = require('../server/lib/startIosProxy');

const program = new Command();
program.version(require('../package.json').version)
  .description('启动 Android WebView / 鸿蒙 ArkWeb / Native CDP 调试服务')
  .option('-p, --port <port>', '本地端口', '8080')
  .option('--adb-path <path>', '指定 ADB 可执行文件')
  .option('--hdc-path <path>', '指定 HDC 可执行文件')
  .option('--device-type <type>', '设备连接方式：auto（仅 Android/鸿蒙）、adb、hdc、ios', 'auto')
  .option('--ios-proxy <url>', 'iOS 调试代理地址（设备列表端口）')
  .option('--ios-proxy-path <path>', '指定 iOS 代理可执行文件')
  .option('--ios-proxy-manifest <path>', '指定跨平台 iOS 代理下载清单')
  .option('--ios-serial <udid>', '指定 iPhone UDID')
  .option('--webkit-frontend <dir>', 'WebKit Web Inspector 资源目录')
  .option('--hdc-serial <serial>', '指定鸿蒙手机序列号')
  .option('--hdc-package <name>', '指定鸿蒙应用进程名')
  .option('--adb-serial <serial>', '指定手机序列号')
  .option('--adb-package <name>', '指定应用进程名')
  .option('--cdp <url>', '连接已有 CDP 端点，跳过 ADB/HDC 准备')
  .option('--no-download', '禁止自动下载 ADB、HDC 和 iOS 代理')
  .option('--no-open', '不自动打开浏览器');

program.command('setup:webkit')
  .description('从远端下载并准备 iOS WebKit 调试前端（需要 Git）')
  .action(() => require('../scripts/setup-webkit')());
program.action(() => main());

async function main() {
  const options = program.opts();
  if (!['auto', 'adb', 'hdc', 'ios'].includes(options.deviceType)) throw new Error('--device-type 必须是 auto、adb、hdc 或 ios。');
  options.cdp = options.cdp || process.env.CHII_CDP_URL;
  const port = Number(options.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口必须在 1–65535 之间。');
  const token = process.env.CHII_CDP_TOKEN || crypto.randomBytes(24).toString('hex');
  if (token.length < 16) throw new Error('CHII_CDP_TOKEN 至少需要 16 个字符。');
  let adbPath;
  let hdcPath;
  if (!options.cdp && options.deviceType !== 'ios') {
    ({ adbPath, hdcPath } = await prepareDeviceTools(options));
    console.log('等待 Android / 鸿蒙手机连接，请解锁手机并确认 USB 调试授权。iPhone 请使用 npm start -- --device-type ios 启动。');
  }
  options.iosProxy = options.iosProxy || process.env.CHII_IOS_PROXY;
  if (options.deviceType === 'ios' || options.iosProxy) {
    options.webkitFrontend = await require('../server/lib/prepareWebkit')(options);
  }
  let proxy;
  if (options.deviceType === 'ios' && !options.iosProxy) {
    proxy = await startIosProxy(options);
    options.iosProxy = proxy.url;
  }
  const listener = http.createServer();
  listener.once('close', () => proxy?.close());
  try {
  await server.start({ ...options, port, server: listener,
    cdpIos: options.deviceType === 'ios' || !!options.iosProxy || !!process.env.CHII_IOS_PROXY,
    iosOnly: options.deviceType === 'ios',
    cdpAdb: !options.cdp && !!adbPath && options.deviceType !== 'hdc',
    cdpHdc: !options.cdp && !!hdcPath && options.deviceType !== 'adb',
    adbPath, hdcPath, cdpToken: token });
  await new Promise((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(port, '127.0.0.1', resolve);
  });
  } catch (error) {
    proxy?.close();
    listener.close();
    throw error;
  }
  const url = `http://127.0.0.1:${port}/cdp/#token=${encodeURIComponent(token)}`;
  console.log(`调试页面: ${url}\n打开页面后自动连接。按 Ctrl+C 停止。`);
  if (options.open) {
    const command = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
    const args = process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
    execFile(command, args, error => { if (error) console.log(`请手动打开 ${url}`); });
  }
}

process.once('SIGINT', () => process.exit(130));
process.once('SIGTERM', () => process.exit(143));
program.parseAsync(process.argv).catch(error => { console.error(error.message); process.exitCode = 1; });
