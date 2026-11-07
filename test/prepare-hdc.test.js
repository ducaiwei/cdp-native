const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const prepareHdc = require('../server/lib/prepareHdc');
const missing = async () => { throw new Error('missing'); };

test('explicit HDC is validated and never silently replaced', async () => {
  assert.equal(await prepareHdc({ hdc: '/custom/hdc', run: async (command, args) => {
    assert.deepEqual(args, ['-v']);
    return { stdout: 'Ver: 3.1.0e' };
  } }), '/custom/hdc');
  await assert.rejects(prepareHdc({ hdc: '/bad', run: missing }), /指定的 HDC/);
  await assert.rejects(prepareHdc({ hdc: '/wrong', run: async () => ({ stdout: 'unrelated tool' }) }), /指定的 HDC/);
});

test('download opt-out and unsupported platforms give actionable errors', async () => {
  await assert.rejects(prepareHdc({ env: {}, run: missing, download: false }), /--hdc-path/);
  await assert.rejects(prepareHdc({ env: {}, run: missing, platform: 'linux', arch: 'arm64' }), /linux\/arm64/);
});

test('discovers HDC in versioned SDK without downloading', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'chii-hdc-sdk-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const sdk = path.join(home, 'sdk');
  const candidate = path.join(sdk, 'default', 'openharmony', 'toolchains', 'hdc');
  await fs.mkdir(path.dirname(candidate), { recursive: true });
  const result = await prepareHdc({ home, env: { DEVECO_SDK_HOME: sdk }, platform: 'linux', download: false,
    run: async command => {
      if (command !== candidate) throw new Error('missing');
      return { stdout: 'Ver: 3.1.0e' };
    },
  });
  assert.equal(result, candidate);
});

for (const platform of ['darwin', 'win32']) {
  test(`${platform}: verifies download, retains libraries, cleans failures and reuses cache`, async t => {
    const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'chii-hdc-test-'));
    t.after(() => fs.rm(cache, { recursive: true, force: true }));
    const executable = platform === 'win32' ? 'hdc.exe' : 'hdc';
    const library = platform === 'win32' ? 'libusb_shared.dll' : 'libusb_shared.dylib';
    let extracts = 0;
    const run = async (command, args, options) => {
      if (command === 'unzip' || command === 'powershell.exe') {
        extracts++;
        const dest = platform === 'win32' ? options.env.CHII_HDC_DEST : args[3];
        await fs.writeFile(path.join(dest, executable), 'fixture');
        await fs.writeFile(path.join(dest, library), 'library');
        return {};
      }
      if (!command.startsWith(cache)) throw new Error('missing');
      await fs.access(command);
      return { stdout: 'Ver: 3.1.0e' };
    };
    const fixture = 'archive fixture';
    const options = { cache, home: cache, env: {}, platform, arch: 'x64', run, log: () => {},
      sources: { [`${platform}-x64`]: ['fixture', createHash('sha256').update(fixture).digest('hex')] },
    };
    await assert.rejects(prepareHdc({ ...options, fetchArchive: async () => new Response('', { status: 503 }) }), /503/);
    await assert.rejects(prepareHdc({ ...options, fetchArchive: async () => new Response('corrupt') }), /SHA-256/);
    assert.equal(extracts, 0);
    assert.deepEqual(await fs.readdir(cache), []);
    let downloads = 0;
    options.fetchArchive = async () => { downloads++; return new Response(fixture); };
    const hdc = await prepareHdc(options);
    assert.equal(await fs.readFile(path.join(path.dirname(hdc), library), 'utf8'), 'library');
    assert.equal(await prepareHdc(options), hdc);
    assert.equal(downloads, 1);
    assert.equal(extracts, 1);
    assert.equal((await fs.readdir(cache)).length, 1);
  });
}
