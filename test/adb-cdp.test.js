const assert = require('node:assert/strict');
const { test } = require('node:test');
const AdbCdp = require('../server/lib/AdbCdp');

function fixture(options = {}) {
  const state = { devices: 'phone\tdevice', sockets: '@webview_devtools_remote_10', forwards: '', port: 31000, calls: [] };
  const adb = new AdbCdp({ ...options, run: async args => {
    state.calls.push(args);
    if (args[0] === 'start-server') return '';
    if (args[0] === 'devices') return state.devices;
    if (args[0] === 'forward') return state.forwards;
    if (args[2] === 'shell') return args[3] === 'pidof' ? '10' : state.sockets;
    if (args[3] === '--remove') { state.forwards = ''; return ''; }
    if (args[3] === 'tcp:0') {
      state.port++;
      state.forwards += `${args[1]} tcp:${state.port} ${args[4]}\n`;
      return String(state.port);
    }
    throw new Error('Unexpected command: ' + args.join(' '));
  } });
  return { adb, state };
}

test('ADB reuses live forwarding, recovers USB disconnect and follows new WebView PID', async () => {
  const { adb, state } = fixture();
  assert.equal((await adb.ensure()).port, '31001');
  assert.equal((await adb.ensure()).port, '31001');
  state.devices = '';
  state.forwards = '';
  await assert.rejects(adb.ensure(), /等待手机/);
  state.devices = 'phone\tdevice';
  assert.equal((await adb.ensure()).port, '31002');
  state.sockets = '@webview_devtools_remote_20';
  assert.equal((await adb.ensure()).port, '31003');
  assert.match(state.forwards, /remote_20/);
  assert.equal(state.calls.filter(args => args[3] === '--remove').length, 1);
});

test('ADB does not choose an ambiguous device, switch phones or choose ambiguous WebViews', async () => {
  const { adb, state } = fixture();
  state.devices += '\nother\tdevice';
  await assert.rejects(adb.ensure(), /多台手机/);
  state.devices = 'phone\tdevice';
  await adb.ensure();
  state.devices = 'other\tdevice';
  await assert.rejects(adb.ensure(), /等待手机/);
  state.devices = 'phone\tdevice';
  state.sockets += '\n@webview_devtools_remote_20';
  const endpoints = await adb.ensure();
  assert.equal(endpoints.length, 2);
  assert.deepEqual(endpoints.map(url => url.process), ['webview_devtools_remote_10', 'webview_devtools_remote_20']);
  assert.notEqual(endpoints[0].port, endpoints[1].port);
  state.sockets = '';
  await assert.rejects(adb.ensure(), /等待 WebView/);
});

test('ADB selectors and concurrent recovery use one forward', async () => {
  const { adb, state } = fixture({ serial: 'phone', packageName: 'com.example.app' });
  state.devices += '\nother\tdevice';
  state.sockets += '\n@webview_devtools_remote_20';
  const urls = await Promise.all([adb.ensure(), adb.ensure(), adb.ensure()]);
  assert.ok(urls.every(url => url.port === '31001'));
  assert.equal(state.calls.filter(args => args[3] === 'tcp:0').length, 1);
  adb.close();
  await assert.rejects(adb.ensure(), /closed/);
});

test('ADB failures are actionable and do not prevent a later retry', async () => {
  const { adb, state } = fixture();
  const run = adb.run;
  adb.run = async () => { throw new Error('ENOENT'); };
  await assert.rejects(adb.ensure(), /CHII_ADB_PATH/);
  adb.run = run;
  state.devices = 'phone\tunauthorized';
  await assert.rejects(adb.ensure(), /授权/);
  state.devices = 'phone\tdevice';
  assert.equal((await adb.ensure()).port, '31001');
});
