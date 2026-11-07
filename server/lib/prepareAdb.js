const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { Readable } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { createWriteStream } = require('node:fs');

const execute = promisify(execFile);

module.exports = async function prepareAdb({
  adb = process.env.CHII_ADB_PATH,
  cache = process.env.CHII_ADB_CACHE || path.join(os.homedir(), '.cache', 'cdp-native'),
  download = true,
  platform = process.platform,
  arch = process.arch,
  run = execute,
  fetchArchive = fetch,
  log = console.log,
} = {}) {
  const executable = platform === 'win32' ? 'adb.exe' : 'adb';
  async function valid(candidate) {
    try {
      const result = await run(candidate, ['version'], { timeout: 10000 });
      return /Android Debug Bridge/.test(result.stdout);
    } catch { return false; }
  }
  if (adb) {
    if (await valid(adb)) return adb;
    throw new Error(`无法运行指定的 ADB: ${adb}`);
  }
  const sdk = process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || (
    platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Android', 'sdk') :
      platform === 'win32' ? path.join(process.env.LOCALAPPDATA || os.homedir(), 'Android', 'Sdk') :
        path.join(os.homedir(), 'Android', 'Sdk')
  );
  const destination = path.join(cache, `${platform}-${arch}`);
  const cached = path.join(destination, 'platform-tools', executable);
  for (const candidate of [path.join(sdk, 'platform-tools', executable), executable, cached]) {
    if (await valid(candidate)) return candidate;
  }
  if (!download) throw new Error('未找到 ADB，请用 --adb-path 指定，或允许自动下载。');
  const systems = { darwin: 'darwin', linux: 'linux', win32: 'windows' };
  if (!systems[platform] || !(arch === 'x64' || (platform === 'darwin' && arch === 'arm64'))) {
    throw new Error(`暂不支持为 ${platform}/${arch} 自动下载 ADB，请用 --adb-path 指定。`);
  }
  await fs.mkdir(cache, { recursive: true });
  const temporary = await fs.mkdtemp(path.join(cache, '.download-'));
  try {
    const url = `https://dl.google.com/android/repository/platform-tools-latest-${systems[platform]}.zip`;
    log(`正在下载 Android Platform-Tools: ${url}`);
    const response = await fetchArchive(url, { signal: AbortSignal.timeout(180000), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error(`ADB 下载失败: HTTP ${response.status}`);
    const zip = path.join(temporary, 'platform-tools.zip');
    await pipeline(Readable.fromWeb(response.body), createWriteStream(zip, { flags: 'wx' }));
    if (platform === 'win32') {
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
        'Expand-Archive -LiteralPath $env:CHII_ADB_ZIP -DestinationPath $env:CHII_ADB_DEST'], {
        timeout: 60000, env: { ...process.env, CHII_ADB_ZIP: zip, CHII_ADB_DEST: temporary },
      });
    } else {
      await run('unzip', ['-q', zip, '-d', temporary], { timeout: 60000 });
      await fs.chmod(path.join(temporary, 'platform-tools', executable), 0o755);
    }
    const installed = path.join(temporary, 'platform-tools', executable);
    if (!(await valid(installed))) throw new Error('下载的 ADB 无法执行，请检查系统兼容性。');
    await fs.unlink(zip);
    try {
      await fs.rename(temporary, destination);
    } catch (error) {
      // Another process may have completed installation while we downloaded.
      if (!(await valid(cached))) throw error;
    }
    return cached;
  } catch (error) {
    throw new Error(`${error.message}\n可手动安装 Platform-Tools 并使用 --adb-path 指定；Linux/macOS 解压需要 unzip。`);
  } finally {
    await fs.rm(temporary, { recursive: true, force: true });
  }
};
