// Select once, then keep that device/transport through disconnects.
module.exports = class DeviceCdp {
  constructor(providers) {
    this.providers = providers;
  }

  ensure() {
    if (this.closed) return Promise.reject(new Error('Device connection closed'));
    if (!this.pending) this.pending = this.connect().finally(() => { this.pending = null; });
    return this.pending;
  }

  async connect() {
    if (this.selected) return this.selected.ensure();
    const results = await Promise.allSettled(this.providers.map(async provider => {
      const devices = await provider.devices();
      return devices.filter(serial => !provider.serial || provider.serial === serial).map(serial => ({ provider, serial }));
    }));
    const candidates = results.flatMap(result => result.status === 'fulfilled' ? result.value : []);
    if (candidates.length > 1) throw new Error('检测到多台设备，请用 --device-type adb/hdc 和对应的 --adb-serial / --hdc-serial 指定手机。');
    if (!candidates.length) {
      const errors = results.filter(result => result.status === 'rejected').map(result => result.reason.message);
      throw new Error(['等待 Android / 鸿蒙手机连接，请解锁手机并确认 USB 调试授权。iPhone 请使用 npm start -- --device-type ios 启动。', ...errors].join('\n'));
    }
    this.selected = candidates[0].provider;
    this.selected.selectedSerial = candidates[0].serial;
    return this.selected.ensure();
  }

  close() {
    this.closed = true;
    for (const provider of this.providers) provider.close();
  }
};
