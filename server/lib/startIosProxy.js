const { spawn } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const prepareIosProxy = require('./prepareIosProxy');
const setupIosProxy = require('../../scripts/setup-ios-proxy');

const url = 'http://127.0.0.1:9221';
module.exports = async function startIosProxy(options = {}, {
  prepare = prepareIosProxy, install = setupIosProxy, launch = spawn, fetchJson = async () => {
    const response = await fetch(`${url}/json`, { signal: AbortSignal.timeout(700), redirect: 'error' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return response.json();
  }, timeout = 10000, log = console.log,
} = {}) {
  async function available() {
    try {
      const devices = await fetchJson();
      if (!Array.isArray(devices) || !devices.every(device => device && typeof device.deviceId === 'string' && typeof device.url === 'string')) {
        throw new Error('9221 端口返回的不是 iOS 设备列表。');
      }
      return true;
    } catch (error) {
      if (error.cause?.code === 'ECONNREFUSED' || error.code === 'ECONNREFUSED') return false;
      throw error;
    }
  }
  if (await available()) return { url, close() {} };
  let executable;
  try {
    executable = await prepare(options);
  } catch (error) {
    const platform = options.platform || process.platform;
    const arch = options.arch || process.arch;
    if (error.code !== 'IOS_PROXY_NOT_INSTALLED' || platform !== 'darwin' || arch !== 'arm64'
      || options.download === false || options.iosProxyPath || process.env.CHII_IOS_PROXY_PATH
      || options.iosProxyManifest || process.env.CHII_IOS_PROXY_MANIFEST) throw error;
    log('未检测到 iOS 代理，正在执行 setup:webkit 的代理安装流程…');
    executable = await install({ platform, arch, log });
  }
  // Recheck after downloading, since another instance may now own the port.
  if (await available()) return { url, close() {} };
  const child = launch(executable, ['--no-frontend', '--config=null:9221,:9222-9322'], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
  });
  let failure;
  let output = '';
  let closed = false;
  const capture = chunk => { output = (output + chunk.toString()).slice(-4096); };
  child.stdout?.on('data', capture);
  child.stderr?.on('data', capture);
  child.on('error', error => { failure = error; });
  child.on('exit', (code, signal) => {
    process.removeListener('exit', close);
    failure = new Error(`iOS 代理已退出 (${signal || code})。${output}`);
    if (!closed) log(failure.message);
  });
  function close() {
    if (closed) return;
    closed = true;
    process.removeListener('exit', close);
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  process.once('exit', close);
  try {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (failure) throw failure;
      if (await available()) {
        if (failure) throw failure;
        log(`iOS 调试代理已就绪: ${url}`);
        return { url, close };
      }
      await delay(100);
    }
    throw new Error(`等待 iOS 代理启动超时。${output}`);
  } catch (error) {
    close();
    const hint = process.platform === 'win32' ? ' 请安装 Apple 官方 iTunes（含 Apple Mobile Device Support），并确认 Apple Mobile Device Service 正在运行。' : '';
    throw new Error(`${error.message}${hint}`, { cause: error });
  }
};
