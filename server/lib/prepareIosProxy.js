const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const defaults = require('./iosProxyBundles.json');

module.exports = async function prepareIosProxy({
  iosProxyPath = process.env.CHII_IOS_PROXY_PATH,
  iosProxyManifest = process.env.CHII_IOS_PROXY_MANIFEST,
  cache = process.env.CHII_IOS_PROXY_CACHE || path.join(os.homedir(), '.cache', 'cdp-native', 'ios'),
  download = true, platform = process.platform, arch = process.arch,
  run = promisify(execFile), fetchArchive = fetch, log = console.log, sources = defaults,
} = {}) {
  const executable = platform === 'win32' ? 'ios_webkit_debug_proxy.exe' : 'ios_webkit_debug_proxy';
  async function valid(candidate) {
    try {
      const { stdout } = await run(candidate, ['--version'], { timeout: 10000, windowsHide: true });
      return /ios[-_]webkit[-_]debug[-_]proxy\s+\d+\./i.test(stdout);
    } catch { return false; }
  }
  if (iosProxyPath) {
    if (await valid(iosProxyPath)) return iosProxyPath;
    throw new Error(`无法运行指定的 iOS 代理: ${iosProxyPath}，请检查架构及动态库依赖。`);
  }
  const candidates = [executable];
  if (platform === 'darwin') {
    const prefixes = arch === 'arm64' ? ['/opt/homebrew', '/usr/local'] : ['/usr/local', '/opt/homebrew'];
    candidates.push(...prefixes.map(prefix => path.join(prefix, 'bin', executable)));
  }
  for (const candidate of candidates) if (await valid(candidate)) return candidate;
  if (iosProxyManifest) sources = { ...sources, ...JSON.parse(await fs.readFile(iosProxyManifest, 'utf8')) };
  const bundle = sources[`${platform}-${arch}`];
  if (!bundle && platform === 'darwin' && ['x64', 'arm64'].includes(arch)) {
    const install = arch === 'arm64'
      ? '请运行 npm run setup:webkit（或 cdp-native setup:webkit）安装代理及依赖'
      : '请运行 brew install ios-webkit-debug-proxy 安装代理及依赖';
    throw Object.assign(new Error(`未检测到可运行的 ${platform}/${arch} iOS 代理。${install}，或用 --ios-proxy-path 指定已安装的代理。`), { code: 'IOS_PROXY_NOT_INSTALLED' });
  }
  if (!bundle) throw new Error(`没有 ${platform}/${arch} 的 iOS 代理下载包。请用 --ios-proxy-manifest 指定包含依赖的预编译包清单，或用 --ios-proxy-path 指定已安装的代理。`);
  if (!/^[a-f0-9]{64}$/i.test(bundle.sha256) || new URL(bundle.url).protocol !== 'https:') {
    throw new Error('iOS 代理下载清单必须提供 HTTPS ZIP 地址和 SHA-256。');
  }
  // Content-addressed installs keep different versions and concurrent installs separate.
  const destination = path.join(cache, `${platform}-${arch}-${bundle.sha256.toLowerCase()}`);
  const cached = path.join(destination, executable);
  if (await valid(cached)) return cached;
  if (!download) throw new Error('未找到 iOS 代理，--no-download 已禁止下载；请用 --ios-proxy-path 指定。');
  await fs.mkdir(cache, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(cache, '.download-'));
  try {
    log(`正在下载 iOS 调试代理: ${bundle.url}`);
    const response = await fetchArchive(bundle.url, { signal: AbortSignal.timeout(180000) });
    if (!response.ok) throw new Error(`iOS 代理下载失败: HTTP ${response.status}`);
    if (response.url && new URL(response.url).protocol !== 'https:') throw new Error('iOS 代理下载不能重定向到非 HTTPS 地址。');
    const bytes = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(bytes).digest('hex') !== bundle.sha256.toLowerCase()) throw new Error('iOS 代理下载包 SHA-256 校验失败。');
    const zip = path.join(temporary, 'proxy.zip');
    const contents = path.join(temporary, 'contents');
    await fs.mkdir(contents);
    await fs.writeFile(zip, bytes, { flag: 'wx' });
    if (platform === 'win32') {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        '$ErrorActionPreference = "Stop"; Expand-Archive -LiteralPath $env:CHII_IOS_ZIP -DestinationPath $env:CHII_IOS_DEST'], {
        timeout: 60000, windowsHide: true,
        env: { ...process.env, CHII_IOS_ZIP: zip, CHII_IOS_DEST: contents },
      });
    } else {
      await run('unzip', ['-q', zip, '-d', contents], { timeout: 60000 });
      await fs.chmod(path.join(contents, executable), 0o755);
    }
    if (!(await valid(path.join(contents, executable)))) throw new Error('下载的 iOS 代理无法运行，请检查系统版本、架构和动态库依赖。');
    if (await valid(cached)) return cached;
    // Never remove another process's installation.
    try { await fs.rename(contents, destination); }
    catch (error) {
      if (!(await valid(cached))) throw new Error(`iOS 代理缓存不可用: ${destination}；请移走此目录后重试。`, { cause: error });
    }
    // Verify after relocation too: macOS bundles must not rely on build-machine paths.
    if (!(await valid(cached))) throw new Error(`iOS 代理移动后无法运行: ${cached}；请检查包内动态库的相对路径。`);
    return cached;
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
};
