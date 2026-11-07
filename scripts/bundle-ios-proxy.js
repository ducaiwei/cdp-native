// Release-maintainer tool. End users download the result; they do not need Homebrew.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const { execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const run = promisify(execFile);

async function main() {
  const [input, licenses, baseUrl, output = 'dist/ios-proxy'] = process.argv.slice(2);
  if (process.platform !== 'darwin' || !input || !licenses || !baseUrl) {
    throw new Error('在目标架构的 macOS 上运行: node scripts/bundle-ios-proxy.js <代理路径> <第三方许可证目录> <HTTPS发布目录URL> [输出目录]');
  }
  if (new URL(baseUrl).protocol !== 'https:') throw new Error('发布地址必须使用 HTTPS。');
  if (!(await fs.readdir(licenses)).length) throw new Error('第三方许可证目录不能为空。');
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'chii-ios-bundle-'));
  const root = path.join(work, 'bundle');
  await fs.mkdir(path.join(root, 'lib'), { recursive: true });
  const copied = new Map();
  const names = new Map();
  const provenance = [];
  const system = name => name.startsWith('/usr/lib/') || name.startsWith('/System/Library/');
  try {
    const sourceExe = await fs.realpath(input);
    async function copyBinary(source, target, library = false) {
      source = await fs.realpath(source);
      if (copied.has(source)) return copied.get(source);
      copied.set(source, target);
      await fs.copyFile(source, target);
      await fs.chmod(target, 0o755);
      const { stdout: info } = await run('lipo', ['-archs', source]);
      const expected = process.arch === 'arm64' ? 'arm64' : 'x86_64';
      if (!info.trim().split(/\s+/).includes(expected)) throw new Error(`架构不匹配: ${source}`);
      provenance.push(source);
      // Homebrew dylibs normally use absolute install names. Fail explicitly on
      // unsupported layouts rather than emitting a bundle with missing libraries.
      const { stdout } = await run('otool', ['-L', source]);
      const dependencies = stdout.split('\n').slice(library ? 2 : 1)
        .map(line => line.trim().split(' (compatibility version')[0]).filter(Boolean);
      for (const dependency of dependencies) {
        if (system(dependency)) continue;
        let resolved = dependency;
        if (resolved.startsWith('@loader_path/')) resolved = path.resolve(path.dirname(source), resolved.slice(13));
        if (resolved.startsWith('@executable_path/')) resolved = path.resolve(path.dirname(sourceExe), resolved.slice(17));
        if (!path.isAbsolute(resolved)) throw new Error(`请先将 ${source} 中的 ${dependency} 解析为绝对路径；不支持此动态库布局。`);
        resolved = await fs.realpath(resolved);
        const name = path.basename(resolved);
        if (names.has(name) && names.get(name) !== resolved) throw new Error(`动态库名称冲突: ${name}`);
        names.set(name, resolved);
        const bundled = await copyBinary(resolved, path.join(root, 'lib', name), true);
        const relative = path.relative(path.dirname(target), bundled);
        await run('install_name_tool', ['-change', dependency, '@loader_path/' + relative, target]);
      }
      if (library) await run('install_name_tool', ['-id', '@loader_path/' + path.basename(target), target]);
      await run('codesign', ['--force', '--sign', '-', target]);
      return target;
    }
    await copyBinary(sourceExe, path.join(root, 'ios_webkit_debug_proxy'));
    await fs.cp(licenses, path.join(root, 'licenses'), { recursive: true });
    const { stdout: version } = await run(path.join(root, 'ios_webkit_debug_proxy'), ['--version']);
    await fs.writeFile(path.join(root, 'PROVENANCE.txt'), `${version}\nBuilt on ${os.release()} / ${process.arch}\nInputs:\n${provenance.join('\n')}\n`);
    // Relocate and test the finished tree before producing the archive.
    const moved = path.join(work, 'relocated');
    await fs.rename(root, moved);
    await run(path.join(moved, 'ios_webkit_debug_proxy'), ['--version']);
    const destination = path.resolve(output);
    await fs.mkdir(destination, { recursive: true });
    const filename = `ios-webkit-debug-proxy-darwin-${process.arch}.zip`;
    const archive = path.join(work, filename);
    await run('zip', ['-qr', archive, '.'], { cwd: moved });
    const sha256 = createHash('sha256').update(await fs.readFile(archive)).digest('hex');
    await fs.copyFile(archive, path.join(destination, filename));
    const manifest = { [`darwin-${process.arch}`]: { url: new URL(filename, baseUrl.replace(/\/?$/, '/')).href, sha256 } };
    await fs.writeFile(path.join(destination, `darwin-${process.arch}.json`), JSON.stringify(manifest, null, 2) + '\n');
    console.log(`已生成 ${path.join(destination, filename)} 和下载清单。请在无 Homebrew 的目标系统验证后发布。`);
  } finally {
    await fs.rm(work, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
