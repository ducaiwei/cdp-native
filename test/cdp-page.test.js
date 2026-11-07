const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const script = fs.readFileSync(require.resolve('../server/tpl/cdp.hbs'), 'utf8').match(/<script>([\s\S]*?)<\/script>/)[1];
function page(fetch) {
  const elements = Object.fromEntries(['status', 'login', 'refresh', 'targets'].map(id => [id, {
    textContent: '', hidden: false, replaceChildren() {}, addEventListener() {},
  }]));
  const timers = new Map();
  let next = 0;
  vm.runInNewContext(script, {
    document: { body: { dataset: { basePath: '/' } }, getElementById: id => elements[id] },
    fetch, AbortController, URLSearchParams, location: { hash: '' },
    setTimeout(fn, delay) { timers.set(++next, { fn, delay }); return next; },
    clearTimeout(id) { timers.delete(id); },
  });
  return { elements, timers };
}
const flush = () => new Promise(resolve => setImmediate(resolve));

test('page retries an initially stalled request and preserves the error during retry', async () => {
  let calls = 0;
  const { elements, timers } = page((url, { signal }) => {
    calls++;
    return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
  });
  [...timers.values()].find(timer => timer.delay === 45000).fn();
  await flush();
  assert.match(elements.status.textContent, /超时/);
  assert.equal(elements.refresh.hidden, false);
  const retry = [...timers.values()].find(timer => timer.delay === 3000);
  assert.ok(retry);
  retry.fn();
  assert.equal(calls, 2);
  assert.match(elements.status.textContent, /超时/);
});

test('page stops polling when authentication is required', async () => {
  const { elements, timers } = page(async () => ({ status: 401 }));
  await flush();
  assert.match(elements.status.textContent, /访问令牌/);
  assert.equal(timers.size, 0);
});
