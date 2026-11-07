const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');

// Same standalone bundles used by liriliri/echo; pin both revision and content.
const revision = 'ce9844f642515b7a3c210bbeb3b92176ea6a332c';
const bundles = {
  'darwin-arm64': ['mac-arm64', 'be8538ac2f4982afb73517a0d2695916548df23db1fb8b75fa01385699deadcb'],
  'darwin-x64': ['mac-x64', 'aac3ac6c735f3b26fb324f70f3835f91f1619306d9167c543520800b707d0df4'],
  'win32-x64': ['win-x64', '9b24e90859062e9f0d4231785a70dcb9ddf0798da061278b52b2ed510d4335a3'],
};

module.exports = async function prepareHdc({
  hdc = process.env.CHII_HDC_PATH,
  cache = process.env.CHII_HDC_CACHE || path.join(os.homedir(), '.cache', 'cdp-native', 'hdc'),
  download = true,
  platform = process.platform,
  arch = process.arch,
  env = process.env,
  home = os.homedir(),
  run = promisify(execFile),
  fetchArchive = fetch,
  log = console.log,
  sources = bundles,
} = {}) {
  const executable = platform === 'win32' ? 'hdc.exe' : 'hdc';
  async function valid(candidate) {
    try {
      const result = await run(candidate, ['-v'], { timeout: 10000 });
      return /\bVer:\s*\d+\.\d+/i.test(result.stdout);
    } catch { return false; }
  }
  if (hdc) {
    if (await valid(hdc)) return hdc;
    throw new Error(`无法运行指定的 HDC: ${hdc}`);
  }
  const candidates = [env.HDC_HOME, env.HDC_SDK_PATH].filter(Boolean).map(dir => path.join(dir, executable));
  const roots = [env.DEVECO_SDK_HOME, env.OHOS_SDK_HOME, env.HOS_SDK_HOME];
  if (platform === 'darwin') {
    roots.push('/Applications/DevEco-Studio.app/Contents/sdk', path.join(home, 'Library', 'Huawei', 'Sdk'), path.join(home, 'Library', 'OpenHarmony', 'Sdk'));
  } else if (platform === 'win32') {
    roots.push(path.join(env.LOCALAPPDATA || home, 'Huawei', 'Sdk'), path.join(env.ProgramFiles || 'C:\\Program Files', 'Huawei', 'DevEco Studio', 'sdk'));
  } else {
    roots.push(path.join(home, 'Huawei', 'Sdk'), path.join(home, 'OpenHarmony', 'Sdk'));
  }
  // Only traverse SDK version/layout directories, never the entire SDK contents.
  async function findToolchains(root, depth = 0) {
    candidates.push(path.join(root, 'toolchains', executable));
    if (depth >= 3) return;
    const entries = await fs.readdir(root, { withFileTypes: true }).catch(() => []);
    for (const entry of entries.sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }))) {
      if (entry.isDirectory() && /^(default|openharmony|harmonyos|hmscore|base|\d[\w.-]*|HarmonyOS[\w.-]*)$/.test(entry.name)) {
        await findToolchains(path.join(root, entry.name), depth + 1);
      }
    }
  }
  for (const root of roots.filter(Boolean)) await findToolchains(root);
  const destination = path.join(cache, `${platform}-${arch}-${revision.slice(0, 12)}`);
  const cached = path.join(destination, executable);
  for (const candidate of [...new Set([...candidates, executable, cached])]) {
    if (await valid(candidate)) return candidate;
  }
  if (!download) throw new Error('未找到 HDC，请用 --hdc-path 指定，或允许自动下载。');
  const bundle = sources[`${platform}-${arch}`];
  if (!bundle) throw new Error(`暂不支持为 ${platform}/${arch} 自动下载 HDC，请安装 DevEco Studio SDK 后用 --hdc-path 指定。`);
  await fs.mkdir(cache, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(cache, '.download-'));
  try {
    const url = `https://raw.githubusercontent.com/liriliri/electron-resources/${revision}/hdc/hdc-${bundle[0]}.zip`;
    log(`正在下载 HDC（liriliri/electron-resources）: ${url}`);
    const response = await fetchArchive(url, { signal: AbortSignal.timeout(180000), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error(`HDC 下载失败: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (createHash('sha256').update(archive).digest('hex') !== bundle[1]) throw new Error('HDC 下载包 SHA-256 校验失败。');
    const zip = path.join(temporary, 'hdc.zip');
    await fs.writeFile(zip, archive, { flag: 'wx' });
    if (platform === 'win32') {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath $env:CHII_HDC_ZIP -DestinationPath $env:CHII_HDC_DEST'], {
        timeout: 60000, env: { ...env, CHII_HDC_ZIP: zip, CHII_HDC_DEST: temporary },
      });
    } else {
      await run('unzip', ['-q', zip, '-d', temporary], { timeout: 60000 });
      await fs.chmod(path.join(temporary, executable), 0o755);
    }
    if (!(await valid(path.join(temporary, executable)))) throw new Error('下载的 HDC 无法执行，请检查系统兼容性。');
    await fs.unlink(zip);
    if (await valid(cached)) return cached;
    await fs.rm(destination, { recursive: true, force: true });
    try {
      await fs.rename(temporary, destination);
    } catch (error) {
      if (!(await valid(cached))) throw error;
    }
    return cached;
  } catch (error) {
    throw new Error(`${error.message}\n可从 DevEco Studio SDK 获取 HDC，并使用 --hdc-path 指定；macOS 解压需要 unzip。`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
};
