const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const net = require('node:net');
const execute = promisify(execFile);

module.exports = class HdcCdp {
  constructor({ hdc = process.env.CHII_HDC_PATH || 'hdc', serial, packageName, run, executeFile = execute, allocatePort = freePort, delay = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
    this.serial = serial;
    this.packageName = packageName;
    this.mappings = new Map();
    this.allocatePort = allocatePort;
    this.delay = delay;
    this.restart = () => {
      if (!this.restarting) {
        this.restarting = executeFile(hdc, ['start', '-r'], { timeout: 10000, maxBuffer: 1024 * 1024 })
          .then(result => {
            if (/\[Fail\]|connect server failed/i.test(result.stdout + result.stderr)) {
              throw new Error(`HDC 重启失败：${result.stdout} ${result.stderr}`);
            }
          }).finally(() => { this.restarting = null; });
      }
      return this.restarting;
    };
    this.run = run || (async args => {
      const options = { timeout: 10000, maxBuffer: 1024 * 1024 };
      // Avoid HDC's slow startup probe on every three-second page refresh.
      let result;
      try {
        result = await executeFile(hdc, ['-p', ...args], options);
      } catch (error) {
        if (!/connect server failed/i.test(`${error.stdout} ${error.stderr}`)) throw error;
        result = { stdout: 'Connect server failed', stderr: '' };
      }
      if (/connect server failed/i.test(result.stdout + result.stderr)) {
        await executeFile(hdc, ['start'], options);
        result = await executeFile(hdc, ['-p', ...args], options);
      }
      return result.stdout + (result.stderr || '');
    });
  }

  async command(args) {
    for (let attempt = 0; ; attempt++) {
      if (this.closed) throw new Error('HDC connection closed');
      let output;
      try {
        output = await this.run(args);
        if (/\[Fail\]|connect server failed/i.test(output)) throw new Error(`HDC: ${output.trim()}`);
        return output;
      } catch (error) {
        const detail = `${error.message} ${error.stdout || ''} ${error.stderr || ''}`;
        if (!/communication channel is being established/i.test(detail)) throw error;
        if (attempt >= 3) throw new Error('鸿蒙设备通信通道仍在建立，请稍候，列表将自动重试。');
        await this.delay(1000);
      }
    }
  }

  async devices() {
    try {
      let output;
      try {
        output = await this.command(['list', 'targets']);
      } catch (error) {
        if (!error.killed || error.signal !== 'SIGTERM') throw error;
        try {
          await this.restart();
          output = await this.command(['list', 'targets']);
        } catch (retryError) {
          throw new Error(`HDC 查询超时后已尝试自动重启，恢复失败：${retryError.killed ? '命令再次超时' : retryError.message}`);
        }
      }
      return output.split(/\r?\n/).map(line => line.trim())
        .filter(line => /^[\w.:-]+$/.test(line));
    } catch (error) {
      throw new Error(`无法查询鸿蒙设备，请检查 HDC 和 USB 调试授权：${error.message}`);
    }
  }

  ensure() {
    if (this.closed) return Promise.reject(new Error('HDC connection closed'));
    if (!this.pending) this.pending = this.connect().finally(() => { this.pending = null; });
    return this.pending;
  }

  async connect() {
    if (this.packageName && !/^[\w.:]+$/.test(this.packageName)) throw new Error('CHII_HDC_PACKAGE 格式无效。');
    let serial = this.serial || this.selectedSerial;
    const readyPromise = this.devices();
    const select = ready => {
      const selected = serial || (ready.length === 1 ? ready[0] : null);
      if (!selected || !ready.includes(selected)) {
        throw new Error(!selected && ready.length > 1 ? '检测到多台鸿蒙手机，请用 --hdc-serial 指定设备。' : '等待鸿蒙手机连接，请解锁手机并确认 USB 调试授权。');
      }
      return selected;
    };
    // Once selected, independent read-only queries can share one round trip.
    // Keep checking device presence on every refresh; never cache stale pages.
    if (!serial) {
      serial = select(await readyPromise);
      this.selectedSerial = serial;
    }
    const command = args => this.command(['-t', serial, ...args]);
    const results = await Promise.allSettled([
      readyPromise.then(select),
      command(['shell', 'cat', '/proc/net/unix']),
      this.command(['fport', 'ls']),
      this.packageName ? command(['shell', 'pidof', this.packageName]) : Promise.resolve(''),
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
    this.selectedSerial = serial;
    const [, sockets, forwards, pidOutput] = results.map(result => result.value);
    if (/permission denied/i.test(sockets)) throw new Error('HDC 无权读取调试端口，请检查设备调试权限。');
    let names = [...new Set([...sockets.matchAll(/@(webview_devtools_remote[\w.-]*)/g)].map(match => match[1]))];
    if (this.packageName) {
      const pids = pidOutput.trim().split(/\s+/);
      names = names.filter(name => pids.some(pid => name === `webview_devtools_remote_${pid}`));
    }
    if (!names.length) throw new Error('鸿蒙手机已连接，等待 ArkWeb：请打开应用网页，并启用 WebviewController.setWebDebuggingAccess(true)。');
    const exists = mapping => forwards.split(/\r?\n/).some(line => {
      const parts = line.trim().split(/\s+/);
      return parts[0] === serial && parts[1] === mapping.local && parts[2] === mapping.remote && parts[3] === '[Forward]';
    });
    for (const [name, mapping] of this.mappings) {
      if (!names.includes(name)) {
        if (exists(mapping)) await command(['fport', 'rm', mapping.local, mapping.remote]);
        this.mappings.delete(name);
      }
    }
    const endpoints = [];
    for (const name of names) {
      let mapping = this.mappings.get(name);
      if (!mapping || !exists(mapping)) {
        const remote = `localabstract:${name}`;
        for (let attempt = 0; attempt < 3; attempt++) {
          const port = await this.allocatePort();
          if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('HDC 转发端口无效。');
          const local = `tcp:${port}`;
          try {
            const output = await command(['fport', local, remote]);
            if (!/Forwardport result:OK/i.test(output)) throw new Error(`HDC 端口转发失败：${output.trim()}`);
            mapping = { local, remote };
            this.mappings.set(name, mapping);
            break;
          } catch (error) {
            if (attempt === 2 || !/listen failed|address.*in use/i.test(error.message)) throw error;
          }
        }
      }
      const endpoint = new URL(`http://127.0.0.1:${mapping.local.slice(4)}/`);
      endpoint.process = name;
      endpoints.push(endpoint);
    }
    return endpoints.length === 1 ? endpoints[0] : endpoints;
  }

  close() {
    this.closed = true;
    // As with ADB, keep mappings to avoid racing another server instance.
  }
};

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}
