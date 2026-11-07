const prepareAdb = require('./prepareAdb');
const prepareHdc = require('./prepareHdc');

module.exports = async function prepareDeviceTools(options, {
  adb = prepareAdb,
  hdc = prepareHdc,
  log = console.log,
} = {}) {
  // Always attempt both tools, even when ADB cannot be downloaded.
  const [adbResult, hdcResult] = await Promise.allSettled([
    adb({ adb: options.adbPath, download: options.download }),
    hdc({ hdc: options.hdcPath, download: options.download }),
  ]);
  for (const [name, result, explicit] of [
    ['ADB', adbResult, options.adbPath || process.env.CHII_ADB_PATH || options.deviceType === 'adb'],
    ['HDC', hdcResult, options.hdcPath || process.env.CHII_HDC_PATH || options.deviceType === 'hdc'],
  ]) {
    if (result.status === 'fulfilled') log(`${name} 已就绪: ${result.value}`);
    else if (explicit) throw result.reason;
    else log(`${name} 未就绪: ${result.reason.message}`);
  }
  if (adbResult.status === 'rejected' && hdcResult.status === 'rejected') {
    throw new Error('ADB 和 HDC 均不可用，请指定至少一种可用的设备调试工具。');
  }
  return {
    adbPath: adbResult.status === 'fulfilled' ? adbResult.value : undefined,
    hdcPath: hdcResult.status === 'fulfilled' ? hdcResult.value : undefined,
  };
};
