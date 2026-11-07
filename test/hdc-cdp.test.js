const { test } = require('node:test');
const assert = require('node:assert/strict');
const HdcCdp = require('../server/lib/HdcCdp');
const DeviceCdp = require('../server/lib/DeviceCdp');

function fixture(options = {}) {
  const state = { devices: 'phone\n', sockets: '@webview_devtools_remote_10', forwards: '', port: 32000, calls: [], fail: '' };
  const hdc = new HdcCdp({ ...options, allocatePort: async () => ++state.port, run: async args => {
    state.calls.push(args);
    if (args[0] === 'list') return state.devices;
    if (args[0] === 'fport') return state.forwards;
    if (args[2] === 'shell') return args[3] === 'pidof' ? '10' : state.sockets;
    if (args[3] === 'rm') { state.forwards = state.forwards.split('\n').filter(line => !line.includes(` ${args[4]} `)).join('\n'); return 'Remove forward ruler success'; }
    if (args[2] === 'fport') {
      if (state.fail) { const fail = state.fail; state.fail = ''; return fail; }
      state.forwards += `${args[1]} ${args[3]} ${args[4]} [Forward]\n`;
      return 'Forwardport result:OK';
    }
    throw new Error('Unexpected command: ' + args.join(' '));
  } });
  return { hdc, state };
}

test('HDC restarts and retries a timed out query once', async () => {
  const calls = [];
  let fail = true;
  const hdc = new HdcCdp({ hdc: '/custom/hdc', executeFile: async (file, args) => {
    assert.equal(file, '/custom/hdc');
    calls.push(args);
    if (args[0] === 'start') return { stdout: '', stderr: '' };
    if (fail) {
      fail = false;
      throw Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' });
    }
    return { stdout: 'phone\n', stderr: '' };
  } });
  assert.deepEqual(await hdc.devices(), ['phone']);
  assert.deepEqual(calls, [['-p', 'list', 'targets'], ['start', '-r'], ['-p', 'list', 'targets']]);
});

test('HDC stops after one failed recovery attempt', async () => {
  let restarts = 0;
  let queries = 0;
  const hdc = new HdcCdp({
    run: async () => {
      queries++;
      throw Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' });
    },
    executeFile: async () => { restarts++; return { stdout: '', stderr: '' }; },
  });
  await assert.rejects(hdc.devices(), /自动重启.*命令再次超时/);
  assert.equal(restarts, 1);
  assert.equal(queries, 2);
});

test('HDC reuses forwarding, reconnects after USB loss and follows restarted ArkWeb', async () => {
  const { hdc, state } = fixture();
  assert.equal((await hdc.ensure()).port, '32001');
  assert.equal((await hdc.ensure()).port, '32001');
  state.devices = '[Empty]'; state.forwards = '';
  await assert.rejects(hdc.ensure(), /等待鸿蒙手机/);
  state.devices = 'phone';
  assert.equal((await hdc.ensure()).port, '32002');
  state.sockets = '@webview_devtools_remote_20';
  assert.equal((await hdc.ensure()).port, '32003');
  assert.equal(state.calls.filter(args => args[3] === 'rm').length, 1);
});

test('HDC lists all ArkWeb processes and never silently switches phones', async () => {
  const { hdc, state } = fixture();
  state.devices = 'phone\nother';
  await assert.rejects(hdc.ensure(), /多台鸿蒙/);
  state.devices = 'phone'; await hdc.ensure();
  state.devices = 'other'; await assert.rejects(hdc.ensure(), /等待鸿蒙手机/);
  state.devices = 'phone'; state.sockets += '\n@webview_devtools_remote_20';
  const endpoints = await hdc.ensure();
  assert.deepEqual(endpoints.map(url => url.process), ['webview_devtools_remote_10', 'webview_devtools_remote_20']);
  assert.deepEqual(endpoints.map(url => url.port), ['32001', '32002']);
  assert.deepEqual((await hdc.ensure()).map(url => url.port), ['32001', '32002']);
  state.sockets = '@webview_devtools_remote_20';
  assert.equal((await hdc.ensure()).port, '32002');
  state.forwards = '';
  assert.equal((await hdc.ensure()).port, '32003');
  state.sockets = ''; await assert.rejects(hdc.ensure(), /setWebDebuggingAccess/);
});

test('HDC supports selectors, concurrent refresh and port collision recovery', async () => {
  const { hdc, state } = fixture({ serial: 'phone', packageName: 'com.example.app' });
  state.devices += '\nother'; state.sockets += '\n@webview_devtools_remote_20';
  state.fail = '[Fail]TCP Port listen failed at 32001';
  const results = await Promise.all([hdc.ensure(), hdc.ensure(), hdc.ensure()]);
  assert.ok(results.every(url => url.port === '32002'));
  assert.equal(state.calls.filter(args => args[3] && args[3].startsWith('tcp:')).length, 2);
  hdc.close(); await assert.rejects(hdc.ensure(), /closed/);
});

test('HDC reports protocol errors even when executable exits successfully', async () => {
  const { hdc, state } = fixture();
  state.devices = '[Fail]device unauthorized';
  await assert.rejects(hdc.ensure(), /unauthorized/);
  state.devices = 'phone'; state.fail = '[Fail]Not support forward-type';
  await assert.rejects(hdc.ensure(), /forward-type/);
  assert.equal((await hdc.ensure()).port, '32002');
});

test('auto mode selects HDC despite broken ADB and preserves device after disconnect', async () => {
  const { hdc, state } = fixture();
  const adb = { devices: async () => { throw new Error('ADB unavailable'); }, close() {} };
  const device = new DeviceCdp([adb, hdc]);
  assert.equal((await device.ensure()).port, '32001');
  state.devices = 'other';
  await assert.rejects(device.ensure(), /等待鸿蒙手机/);
  device.close(); await assert.rejects(device.ensure(), /closed/);
});

test('auto mode rejects Android/HarmonyOS ambiguity and retries when no devices exist', async () => {
  const { hdc, state } = fixture();
  const adb = { devices: async () => ['android'] };
  const device = new DeviceCdp([adb, hdc]);
  await assert.rejects(device.ensure(), /多台设备/);
  adb.devices = async () => []; state.devices = '[Empty]';
  await assert.rejects(device.ensure(), /USB 调试授权/);
  state.devices = 'phone';
  assert.equal((await device.ensure()).port, '32001');
});

test('HDC waits for channel establishment for stdout and rejected commands', async () => {
  for (const rejected of [false, true]) {
    let calls = 0;
    const waits = [];
    const hdc = new HdcCdp({
      delay: async ms => waits.push(ms),
      run: async () => {
        if (++calls === 3) return 'phone\n';
        const message = '[Fail][E000004]:The communication channel is being established.';
        if (rejected) throw Object.assign(new Error('Command failed'), { stderr: message });
        return message;
      },
    });
    assert.deepEqual(await hdc.devices(), ['phone']);
    assert.deepEqual(waits, [1000, 1000]);
  }
});

test('HDC bounds channel retries and does not retry unrelated failures', async () => {
  let calls = 0;
  const hdc = new HdcCdp({ delay: async () => {}, run: async () => {
    calls++;
    return '[Fail][E000004]:The communication channel is being established.';
  } });
  await assert.rejects(hdc.command(['list', 'targets']), /通信通道仍在建立/);
  assert.equal(calls, 4);
  hdc.run = async () => { calls++; return '[Fail]device unauthorized'; };
  await assert.rejects(hdc.command(['list', 'targets']), /unauthorized/);
  assert.equal(calls, 5);
});

test('HDC stops channel retries after closing', async () => {
  let calls = 0;
  const hdc = new HdcCdp({ delay: async () => hdc.close(), run: async () => {
    calls++;
    return '[Fail]:The communication channel is being established.';
  } });
  await assert.rejects(hdc.command(['list', 'targets']), /closed/);
  assert.equal(calls, 1);
});

test('selected HDC refresh overlaps read-only queries and waits before forwarding', async () => {
  const pending = [];
  const hdc = new HdcCdp({ serial: 'phone', packageName: 'com.example.app', allocatePort: async () => 32001,
    run: args => {
      if (args[2] === 'fport') {
        assert.equal(pending.length, 4);
        return Promise.resolve('Forwardport result:OK');
      }
      return new Promise(resolve => pending.push({ args, resolve }));
    },
  });
  const refresh = hdc.ensure();
  assert.equal(pending.length, 4, 'all discovery reads start without waiting for another read');
  for (const { args, resolve } of pending) {
    resolve(args[0] === 'list' ? 'phone' : args[0] === 'fport' ? '' : args[3] === 'pidof' ? '10' : '@webview_devtools_remote_10');
  }
  assert.equal((await refresh).port, '32001');
});
