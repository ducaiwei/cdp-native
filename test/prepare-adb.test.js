const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const prepareAdb = require('../server/lib/prepareAdb');

test('explicit ADB is validated and never silently replaced', async () => {
  const options = { adb: '/custom/adb', run: async () => ({ stdout: 'Android Debug Bridge version 1.0.41' }) };
  assert.equal(await prepareAdb(options), '/custom/adb');
  await assert.rejects(prepareAdb({ ...options, run: async () => { throw new Error('missing'); } }), /指定的 ADB/);
});

test('download is opt-out and unsupported architectures give an actionable error', async () => {
  const run = async () => { throw new Error('missing'); };
  await assert.rejects(prepareAdb({ run, download: false }), /--adb-path/);
  await assert.rejects(prepareAdb({ run, platform: 'linux', arch: 'arm64' }), /linux\/arm64/);
});

test('download failure cleans up, retry installs full tools and subsequent calls use cache', async t => {
  const cache = await fs.mkdtemp(path.join(os.tmpdir(), 'chii-adb-test-'));
  t.after(() => fs.rm(cache, { recursive: true, force: true }));
  const run = async (command, args) => {
    if (command === 'unzip') {
      const tools = path.join(args[3], 'platform-tools');
      await fs.mkdir(tools);
      await fs.writeFile(path.join(tools, 'adb'), 'fixture');
      await fs.writeFile(path.join(tools, 'NOTICE.txt'), 'license');
      return {};
    }
    if (!command.startsWith(cache)) throw new Error('missing');
    await fs.access(command);
    return { stdout: 'Android Debug Bridge version 1.0.41' };
  };
  const options = { cache, run, platform: 'linux', arch: 'x64', log: () => {} };
  await assert.rejects(prepareAdb({ ...options, fetchArchive: async () => new Response('', { status: 503 }) }), /503/);
  assert.deepEqual(await fs.readdir(cache), []);
  let downloads = 0;
  options.fetchArchive = async url => {
    downloads++;
    assert.equal(url, 'https://dl.google.com/android/repository/platform-tools-latest-linux.zip');
    return new Response('archive fixture');
  };
  const adb = await prepareAdb(options);
  assert.equal(adb, path.join(cache, 'linux-x64', 'platform-tools', 'adb'));
  assert.equal(await fs.readFile(path.join(path.dirname(adb), 'NOTICE.txt'), 'utf8'), 'license');
  assert.equal(await prepareAdb(options), adb);
  assert.equal(downloads, 1);
  assert.deepEqual(await fs.readdir(cache), ['linux-x64']);
});
