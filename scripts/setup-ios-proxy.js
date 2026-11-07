const { execFileSync } = require('node:child_process');
const prepareIosProxy = require('../server/lib/prepareIosProxy');

module.exports = async function setupIosProxy({
  platform = process.platform, arch = process.arch,
  prepare = prepareIosProxy, run = execFileSync, log = console.log,
} = {}) {
  if (platform !== 'darwin' || arch !== 'arm64') return;
  try {
    return await prepare({ download: false, platform, arch });
  } catch (error) {
    if (process.env.CHII_IOS_PROXY_PATH || process.env.CHII_IOS_PROXY_MANIFEST) throw error;
  }
  let brew;
  for (const candidate of ['/opt/homebrew/bin/brew', 'brew', '/usr/local/bin/brew']) {
    try {
      run(candidate, ['--version'], { stdio: 'pipe', timeout: 10000 });
      brew = candidate;
      break;
    } catch {}
  }
  if (!brew) throw new Error('安装 iOS 代理需要 Homebrew，请先从 https://brew.sh 安装后重新运行 setup:webkit。');
  log('[WebKit] 正在通过 Homebrew 安装 iOS 代理及依赖…');
  try {
    run(brew, ['install', 'ios-webkit-debug-proxy'], { stdio: 'inherit' });
  } catch (error) {
    throw new Error('iOS 代理安装失败，请运行 brew install ios-webkit-debug-proxy 后重试 setup:webkit。', { cause: error });
  }
  const proxy = await prepare({ download: false, platform, arch });
  log(`[WebKit] iOS 代理已准备：${proxy}`);
  return proxy;
};
