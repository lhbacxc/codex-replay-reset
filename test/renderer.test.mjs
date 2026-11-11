import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
test('页面注册、插槽构建、运行态按钮与清理逻辑离线验收', async () => {
  const nodes = [], registrations = {slots: [], rows: [], composers: [], scans: [], effects: []};
  const id = '01900000-0000-7000-8000-000000000001';
  let primaryLabel = '停止', lastBackend;
  function element(tag) {
    const item = {tag, dataset: {}, children: [], isConnected: true, textContent: '', disabled: false,
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; }, remove() { this.isConnected = false; }};
    nodes.push(item); return item;
  }
  const document = {createElement: element, head: element('head'),
    querySelector: () => ({getAttribute: () => primaryLabel}),
    querySelectorAll: () => [{getClientRects: () => [1], getAttribute: () => id}]};
  const status = {attached: true, ready: true, endpoint: 'http://127.0.0.1:18761/v1', upstream: 'http://127.0.0.1:15721/v1', sessions: []};
  const ctx = {
    config: {autoAttach: false},
    backend: {async call(method) { lastBackend = method; return status; }},
    registerSidePanel(def) { registrations.panel = def; return {open() {}}; },
    registerSlot(def) { registrations.slots.push(def); },
    registerRowAction(def) { registrations.rows.push(def); },
    registerComposerAction(def) { registrations.composers.push(def); },
    on() {}, onScan(fn) { registrations.scans.push(fn); },
    effect(fn) { registrations.effects.push(fn()); },
    setInterval() { return () => {}; }, toast() {},
  };
  const source = await fs.readFile(new URL('../renderer.js', import.meta.url), 'utf8');
  vm.runInNewContext(source, {codexPlus: {extension: fn => fn(ctx)}, document,
    crypto: {randomUUID: () => '01900000-0000-7000-8000-000000000002'}, console});
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(registrations.slots[0].slot, 'composer.above');
  assert.equal(registrations.rows[0].label, '重置旧回放');
  const container = element('div');
  const dispose = registrations.slots[0].render({container});
  const button = nodes.find(x => x.textContent === '↻ 重置旧回放');
  assert.equal(button.disabled, true);
  primaryLabel = '发送'; registrations.scans.forEach(fn => fn());
  assert.equal(button.disabled, false);
  assert.equal(nodes.find(x => x.tag === 'style').dataset.codexPlusExt, 'codex-replay-reset');
  registrations.panel.render({container: element('div')});
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(nodes.some(x => x.textContent === '解除接入'));
  assert.equal(lastBackend, 'status');
  dispose(); registrations.effects.forEach(fn => fn?.());
});
