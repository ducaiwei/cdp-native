// Optional WebKit frontend; upstream adaptations retain their own licenses.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const webkitRevision = '0a8bb6470781421c51bfbb68ba17f633c8f91c52';
const kitRevision = '5c44158446ecafbbeff1cfd6d06ad27ff1a37cc5';
async function checkout(url, revision, dir, sparse) {
  const git = args => {
    console.log(`[WebKit] git ${args.join(' ')}`);
    try {
      execFileSync('git', ['-C', dir, '-c', 'http.lowSpeedLimit=1', '-c', 'http.lowSpeedTime=60', ...args], {
        stdio: 'inherit', timeout: 300000, killSignal: 'SIGKILL',
        env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
      });
    } catch (error) {
      const reason = error.code === 'ETIMEDOUT' ? '超过 5 分钟未完成' : '执行失败';
      throw new Error(`WebKit 下载步骤${reason}: git ${args.join(' ')}。请检查 Git 到 ${url} 的网络或代理配置后重试；也可通过 CHII_WEBKIT_SOURCE 和 CHII_WEBKIT_KIT_SOURCE 指定本地源码。`, { cause: error });
    }
  };
  await fs.mkdir(dir, { recursive: true });
  git(['init']);
  git(['remote', 'add', 'origin', url]);
  if (sparse) {
    git(['sparse-checkout', 'init', '--cone']);
    git(['sparse-checkout', 'set', sparse]);
  }
  git(['fetch', '--progress', '--depth', '1', '--filter=blob:none', 'origin', revision]);
  git(['checkout', '--progress', '--detach', 'FETCH_HEAD']);
}
async function main({ output = path.join(root, 'public/webkit') } = {}) {
  await require('./setup-ios-proxy')();
  try {
    await fs.access(path.join(output, 'Main.html'));
    console.log(`WebKit 前端已存在：${output}`);
    return;
  }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  try { await fs.access(output); throw new Error('public/webkit 已存在但不完整；请移走后再准备，避免覆盖现有资源。'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const work = await fs.mkdtemp(path.join(os.tmpdir(), 'cdp-webkit-'));
  console.log(`准备 WebKit 前端，临时目录：${work}`);
  const webkit = process.env.CHII_WEBKIT_SOURCE || path.join(work, 'WebKit');
  const kit = process.env.CHII_WEBKIT_KIT_SOURCE || path.join(work, 'kit');
  if (!process.env.CHII_WEBKIT_SOURCE) await checkout('https://github.com/WebKit/WebKit.git', webkitRevision, webkit, 'Source/WebInspectorUI/UserInterface');
  if (!process.env.CHII_WEBKIT_KIT_SOURCE) await checkout('https://github.com/HimbeersaftLP/ios-safari-remote-debug-kit.git', kitRevision, kit);
  const staging = path.join(work, 'frontend');
  await fs.cp(path.join(webkit, 'Source/WebInspectorUI/UserInterface'), staging, { recursive: true });
  await fs.cp(path.join(kit, 'src/injectedCode'), staging, { recursive: true });
  const htmlPath = path.join(staging, 'Main.html');
  let html = await fs.readFile(htmlPath, 'utf8');
  // Optional Apple-internal additions and generated completion hints are not in this source checkout.
  for (const asset of ['WebKitAdditions/WebInspectorUI/WebInspectorUIAdditions.css', 'WebKitAdditions/WebInspectorUI/WebInspectorUIAdditions.js', 'Models/NativeFunctionParameters.js']) {
    html = html.split('\n').filter(line => !line.includes('"' + asset + '"')).join('\n');
  }
  if (!html.includes('</head>')) throw new Error('Unsupported WebKit frontend HTML');
  await fs.writeFile(htmlPath, html.replace('</head>', '<script src="AdditionalJavaScript.js"></script><link rel="stylesheet" href="AdditionalStyle.css"></head>'));
  const hostFile = path.join(staging, 'Base/BrowserInspectorFrontendHost.js');
  const host = await fs.readFile(hostFile, 'utf8');
  const wsLine = 'let url = "ws" in queryParams ? "ws://" + queryParams.ws : null;';
  if (!host.includes(wsLine)) throw new Error('Unsupported WebKit WebSocket initialization');
  await fs.writeFile(hostFile, host.replace(wsLine, 'let url = "wss" in queryParams ? "wss://" + queryParams.wss : ("ws" in queryParams ? "ws://" + queryParams.ws : null);'));
  const protocol = path.join(staging, 'Protocol');
  const versions = (await fs.readdir(path.join(protocol, 'Legacy/iOS'))).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const version = process.env.CHII_IOS_PROTOCOL_VERSION || versions.at(-1);
  if (!versions.includes(version)) throw new Error(`不支持的 iOS 协议版本：${version}`);
  await fs.copyFile(path.join(protocol, 'Legacy/iOS', version, 'InspectorBackendCommands.js'), path.join(protocol, 'InspectorBackendCommands.js'));
  await fs.copyFile(path.join(kit, 'LICENSE'), path.join(staging, 'REMOTE-DEBUG-KIT-LICENSE'));
  await fs.writeFile(path.join(staging, 'PROVENANCE.txt'), `WebKit: https://github.com/WebKit/WebKit/tree/${webkitRevision}\nAdaptations (GPL-3.0): https://github.com/HimbeersaftLP/ios-safari-remote-debug-kit/tree/${kitRevision}\nProtocol: iOS ${version}\nOriginal WebKit copyright and license headers are retained in source files.\n`);
  await fs.cp(staging, output, { recursive: true });
  console.log(`WebKit 前端已准备：${output}（iOS 协议 ${version}）`);
}
module.exports = main;
if (require.main === module) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
