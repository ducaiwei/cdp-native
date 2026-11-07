const { execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');
const os = require('os');
const path = require('path');

const execute = promisify(execFile);

// Use an ADB-assigned port so existing Chrome/debugger listeners are never replaced.
module.exports = class AdbCdp {
  constructor({ adb, serial, packageName, run } = {}) {
    const sdkAdb = path.join(process.env.ANDROID_HOME || process.env.ANDROID_SDK_ROOT || path.join(os.homedir(), 'Library/Android/sdk'), 'platform-tools/adb');
    this.adb = adb || (fs.existsSync(sdkAdb) ? sdkAdb : 'adb');
    this.serial = serial;
    this.packageName = packageName;
    this.run = run || (async args => (await execute(this.adb, args, { timeout: 5000, maxBuffer: 1024 * 1024 })).stdout);
    this.closed = false;
    this.mappings = new Map();
  }

  ensure() {
    if (this.closed) return Promise.reject(new Error('ADB connection closed'));
    if (!this.pending) this.pending = this.connect().finally(() => { this.pending = null; });
    return this.pending;
  }

  async devices() {
    let devices;
    try {
      await this.run(['start-server']);
      devices = await this.run(['devices']);
    } catch {
      throw new Error('无法运行 ADB，请检查 CHII_ADB_PATH 和 Android platform-tools。');
    }
    return devices.split(/\r?\n/).map(line => line.trim().split(/\s+/)).filter(parts => parts[1] === 'device').map(parts => parts[0]);
  }

  async connect() {
    const ready = await this.devices();
    const serial = this.serial || this.selectedSerial || (ready.length === 1 ? ready[0] : null);
    if (!serial || !ready.includes(serial)) {
      throw new Error(ready.length > 1 && !serial ? '检测到多台手机，请配置 CHII_ADB_SERIAL。' : '等待手机连接，请解锁手机并确认 USB 调试授权。');
    }
    this.selectedSerial = serial;
    const shell = args => this.run(['-s', serial, 'shell', ...args]);
    const sockets = await shell(['cat', '/proc/net/unix']);
    let names = [...new Set([...sockets.matchAll(/@((?:webview_devtools_remote)[\w.-]*)/g)].map(match => match[1]))];
    if (this.packageName) {
      if (!/^[\w.:]+$/.test(this.packageName)) throw new Error('CHII_ADB_PACKAGE 格式无效。');
      const pids = (await shell(['pidof', this.packageName])).trim().split(/\s+/);
      names = names.filter(name => pids.some(pid => name === `webview_devtools_remote_${pid}`));
    }
    if (!names.length) throw new Error('等待 WebView，请打开应用页面并启用 WebView debugging。');
    const forwards = await this.run(['forward', '--list']);
    const exists = mapping => forwards.split(/\r?\n/).some(line => {
      const parts = line.trim().split(/\s+/);
      return parts[0] === serial && parts[1] === mapping.local && parts[2] === mapping.remote;
    });
    for (const [name, mapping] of this.mappings) {
      if (!names.includes(name)) {
        if (exists(mapping)) await this.run(['-s', serial, 'forward', '--remove', mapping.local]);
        this.mappings.delete(name);
      }
    }
    const endpoints = [];
    for (const name of names) {
      let mapping = this.mappings.get(name);
      if (!mapping || !exists(mapping)) {
        const remote = `localabstract:${name}`;
        const port = (await this.run(['-s', serial, 'forward', 'tcp:0', remote])).trim();
        if (!/^\d+$/.test(port) || +port < 1 || +port > 65535) throw new Error('ADB 未返回有效转发端口。');
        mapping = { local: `tcp:${port}`, remote };
        this.mappings.set(name, mapping);
      }
      const endpoint = new URL(`http://127.0.0.1:${mapping.local.slice(4)}/`);
      endpoint.process = name;
      endpoints.push(endpoint);
    }
    return endpoints.length === 1 ? endpoints[0] : endpoints;
  }

  close() {
    this.closed = true;
    // Keep the mapping: removing it asynchronously could race a new server instance.
  }
};
