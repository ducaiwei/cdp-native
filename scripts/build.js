const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
function check(dir) {
  for (const item of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, item.name);
    if (item.isDirectory()) check(file);
    else if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', file]);
  }
}
for (const dir of ['bin', 'server', 'scripts']) check(path.join(root, dir));
for (const file of ['public/front_end/inspector.html', 'public/front_end/entrypoints/inspector/inspector.js', 'public/front_end/LICENSE']) {
  if (!fs.statSync(path.join(root, file)).size) throw new Error(`Empty resource: ${file}`);
}
require('handlebars').precompile(fs.readFileSync(path.join(root, 'server/tpl/cdp.hbs'), 'utf8'));
console.log('Build verified: server, CLI, template and bundled DevTools.');
