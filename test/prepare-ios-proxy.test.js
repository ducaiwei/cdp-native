const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const prepare = require('../server/lib/prepareIosProxy');
const missing = async () => { throw new Error('missing'); };

test('explicit iOS proxy path is validated; download opt-out and unsupported architectures are actionable', async () => {
  assert.equal(await prepare({ iosProxyPath: '/custom/proxy', run: async () => ({ stdout: 'ios-webkit-debug-proxy 1.9.1' }) }), '/custom/proxy');
  await assert.rejects(prepare({ iosProxyPath: '/bad', run: missing }), /指定的 iOS/);
  await assert.rejects(prepare({ platform: 'win32', arch: 'x64', run: missing, download: false }), /no-download/);
  await assert.rejects(prepare({ platform: 'win32', arch: 'arm64', run: missing }), /win32\/arm64/);
});

for (const [platform, arch] of [['win32', 'x64'], ['darwin', 'x64'], ['darwin', 'arm64'], ['linux', 'x64']]) {
  test(`${platform}/${arch}: custom manifest, hash validation, dependency retention and offline cache reuse`, async t => {
    const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'chii-ios-test-'));
    t.after(() => fs.rm(cache, { recursive: true, force: true }));
    const executable = 'ios_webkit_debug_proxy' + (platform === 'win32' ? '.exe' : '');
    const library = platform === 'win32' ? 'libplist.dll' : 'libplist.dylib';
    const fixture = 'archive';
    const manifest = path.join(cache, 'manifest.json');
    await fs.writeFile(manifest, JSON.stringify({ [`${platform}-${arch}`]: {
      url: 'https://downloads.example.test/proxy.zip', sha256: createHash('sha256').update(fixture).digest('hex'),
    } }));
    let extracts = 0;
    let downloads = 0;
    const run = async (command, args, options) => {
      if (command === 'powershell.exe' || command === 'unzip') {
        extracts++;
        const dest = platform === 'win32' ? options.env.CHII_IOS_DEST : args[3];
        await fs.writeFile(path.join(dest, executable), 'fixture');
        await fs.writeFile(path.join(dest, library), 'dependency');
        return {};
      }
      if (!command.startsWith(cache)) throw new Error('missing');
      await fs.access(command);
      return { stdout: 'ios-webkit-debug-proxy 1.9.1' };
    };
    const options = { platform, arch, cache, iosProxyManifest: manifest, run, log() {} };
    await assert.rejects(prepare({ ...options, fetchArchive: async () => new Response('', { status: 503 }) }), /503/);
    await assert.rejects(prepare({ ...options, fetchArchive: async () => new Response('corrupt') }), /SHA-256/);
    assert.equal(extracts, 0);
    assert.deepEqual(await fs.readdir(cache), ['manifest.json']);
    const result = await prepare({ ...options, fetchArchive: async () => { downloads++; return new Response(fixture); } });
    assert.equal(await fs.readFile(path.join(path.dirname(result), library), 'utf8'), 'dependency');
    assert.equal(await prepare({ ...options, download: false, fetchArchive: missing }), result);
    assert.equal(downloads, 1);
    assert.equal(extracts, 1);
  });
}
