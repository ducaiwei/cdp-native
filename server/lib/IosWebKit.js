// ios-webkit-debug-proxy exposes a device registry on /json and one port per device.
module.exports = class IosWebKit {
  constructor({ url = 'http://127.0.0.1:9221', serial, fetchJson } = {}) {
    this.url = new URL(url);
    if (!['http:', 'https:'].includes(this.url.protocol) || this.url.username || this.url.password) throw new Error('iOS proxy URL must be HTTP(S) without credentials');
    this.serial = serial;
    this.fetchJson = fetchJson || (async url => {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: 'error' });
      if (!response.ok) throw new Error(`iOS proxy HTTP ${response.status}`);
      return response.json();
    });
  }

  async discover() {
    let devices;
    try { devices = await this.fetchJson(new URL('/json', this.url)); }
    catch (error) {
      const detail = error.cause?.code || error.message;
      throw new Error(`无法连接本机 iOS 调试代理 ${this.url.origin}（${detail}）。请先安装并运行 ios_webkit_debug_proxy --no-frontend；此时尚未查询到手机授权状态。`);
    }
    if (!Array.isArray(devices)) throw new Error('Invalid iOS device list');
    const selected = devices.filter(device => device.deviceId && (!this.serial || device.deviceId === this.serial));
    if (!selected.length) throw new Error('等待 iPhone 连接：请解锁、信任电脑，并开启 Safari Web Inspector。');
    const results = await Promise.allSettled(selected.map(async device => {
      const advertised = new URL(/^https?:\/\//.test(device.url) ? device.url : `http://${device.url}`);
      if (!advertised.port || !/^\d+$/.test(advertised.port)) throw new Error('Invalid iOS device port');
      // Trust only the configured proxy host; registry entries may select a port, never a host.
      const endpoint = new URL(this.url.origin);
      endpoint.port = advertised.port;
      const pages = await this.fetchJson(new URL('/json', endpoint));
      if (!Array.isArray(pages)) throw new Error('Invalid iOS page list');
      return pages.filter(page => page.webSocketDebuggerUrl && (page.type === 'page' || !page.type)).map(page => ({
        id: JSON.stringify(['ios', device.deviceId, String(page.id)]),
        title: page.title, url: page.url, process: device.deviceName || device.deviceId,
        frontend: 'webkit', endpoint, webSocketDebuggerUrl: page.webSocketDebuggerUrl,
      }));
    }));
    if (results.every(result => result.status === 'rejected')) throw results[0].reason;
    return results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
  }
};
