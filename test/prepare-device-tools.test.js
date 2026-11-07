const { test } = require('node:test');
const assert = require('node:assert/strict');
const prepareDeviceTools = require('../server/lib/prepareDeviceTools');

test('startup prepares both tools with shared download policy and explicit paths', async () => {
  const calls = [];
  const result = await prepareDeviceTools({ adbPath: '/adb', hdcPath: '/hdc', download: false }, {
    adb: async options => { calls.push(options); return '/adb'; },
    hdc: async options => { calls.push(options); return '/hdc'; },
    log: () => {},
  });
  assert.deepEqual(calls, [{ adb: '/adb', download: false }, { hdc: '/hdc', download: false }]);
  assert.deepEqual(result, { adbPath: '/adb', hdcPath: '/hdc' });
});

test('optional HDC failure does not block Android; invalid explicit HDC fails clearly', async () => {
  const logs = [];
  const dependencies = {
    adb: async () => '/adb',
    hdc: async () => { throw new Error('HDC unavailable'); },
    log: message => logs.push(message),
  };
  const result = await prepareDeviceTools({}, dependencies);
  assert.equal(result.adbPath, '/adb');
  assert.ok(logs.some(log => /HDC unavailable/.test(log)));
  await assert.rejects(prepareDeviceTools({ hdcPath: '/bad' }, dependencies), /HDC unavailable/);
});

test('HDC is still prepared when ADB fails', async () => {
  let prepared = false;
  const result = await prepareDeviceTools({}, {
    adb: async () => { throw new Error('ADB unavailable'); },
    hdc: async () => { prepared = true; return '/hdc'; },
    log: () => {},
  });
  assert.equal(prepared, true);
  assert.deepEqual(result, { adbPath: undefined, hdcPath: '/hdc' });
});

test('explicit transport and total preparation failure are fatal', async () => {
  const dependencies = { adb: async () => { throw new Error('ADB unavailable'); }, hdc: async () => '/hdc', log: () => {} };
  await assert.rejects(prepareDeviceTools({ deviceType: 'adb' }, dependencies), /ADB unavailable/);
  await assert.rejects(prepareDeviceTools({}, { ...dependencies, hdc: dependencies.adb }), /均不可用/);
});
