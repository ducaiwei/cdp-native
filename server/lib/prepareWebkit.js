const fs = require('node:fs/promises');
const path = require('node:path');
const setup = require('../../scripts/setup-webkit');

module.exports = async function prepareWebkit({
  webkitFrontend = process.env.CHII_WEBKIT_FRONTEND || path.resolve(__dirname, '../../public/webkit'),
  download = true,
} = {}, { install = setup, log = console.log } = {}) {
  const output = path.resolve(webkitFrontend);
  try {
    if ((await fs.stat(path.join(output, 'Main.html'))).isFile()) return output;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  if (!download) throw new Error('缺少 WebKit 前端，--no-download 已禁止下载；请先运行 cdp-native setup:webkit 或指定已安装的 --webkit-frontend。');
  log('未检测到 WebKit 前端，正在自动执行 setup:webkit…');
  await install({ output });
  if (!(await fs.stat(path.join(output, 'Main.html'))).isFile()) throw new Error('WebKit 安装后缺少 Main.html。');
  return output;
};
