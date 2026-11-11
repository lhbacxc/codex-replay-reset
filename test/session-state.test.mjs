import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {assertSessionIdle, inspectRollout} from '../core/session-state.mjs';
const id = '01900000-0000-7000-8000-000000000001';
const other = '01900000-0000-7000-8000-000000000002';
async function fixture(rows, callback, directory = 'sessions') {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-replay-reset-test-'));
  const folder = path.join(home, directory, '2026', '11', '11');
  await fs.mkdir(folder, {recursive: true});
  const file = path.join(folder, 'rollout-synthetic-' + id + '.jsonl');
  await fs.writeFile(file, rows.map(x => JSON.stringify(x)).join('\n') + '\n', 'utf8');
  try { await callback({codexHome: home, file}); }
  finally {
    assert.equal(path.dirname(path.resolve(home)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(home).startsWith('codex-replay-reset-test-'));
    await fs.rm(home, {recursive: true, force: true});
  }
}
const row = (type, payload) => ({type, payload});
const idle = () => [row('session_meta', {id}), row('event_msg', {type: 'task_started', turn_id: 't1'}),
  row('response_item', {type: 'custom_tool_call', call_id: 'keep'}),
  row('response_item', {type: 'custom_tool_call_output', call_id: 'keep'}),
  row('event_msg', {type: 'task_complete', turn_id: 't1'})];
test('复现宿主索引没有找到会话，回退原生记录且文件不变', async () => {
  await fixture(idle(), async ({codexHome, file}) => {
    const before = await fs.readFile(file, 'utf8');
    const result = await assertSessionIdle({id, codexHome, sessionQuery: {
      async listEvents() { throw Error('没有找到会话 ' + id + ' at handleHostReply (file:///synthetic:1:1)'); },
    }});
    assert.equal(result.source, 'rollout'); assert.equal(result.id, id); assert.equal(result.idle, true);
    assert.equal(await fs.readFile(file, 'utf8'), before);
  });
});
test('空索引及缺少宿主查询服务均能识别归档本地会话', async () => {
  await fixture(idle(), async ({codexHome}) => {
    assert.equal((await assertSessionIdle({id, codexHome, sessionQuery: {async listEvents() { return []; }}})).source, 'rollout');
    assert.equal((await assertSessionIdle({id, codexHome})).source, 'rollout');
  }, 'archived_sessions');
});
test('宿主运行态不会通过原生回退绕过', async () => {
  await fixture(idle(), async ({codexHome}) => {
    await assert.rejects(assertSessionIdle({id, codexHome, sessionQuery: {async listEvents() { return [{type: 'turn/start', seq: 5}]; }}}), /仍在运行/);
  });
});
test('未知宿主查询错误和无效格式拒绝重置', async () => {
  await fixture(idle(), async ({codexHome}) => {
    await assert.rejects(assertSessionIdle({id, codexHome, sessionQuery: {async listEvents() { throw Error('transport closed'); }}}), /查询失败/);
    await assert.rejects(assertSessionIdle({id, codexHome, sessionQuery: {async listEvents() { return {unknown: []}; }}}), /格式无法识别/);
  });
});
test('宿主已确认结束保留原有查询路径', async () => {
  const result = await assertSessionIdle({id, sessionQuery: {async listEvents() { return [{type: 'turn/complete', seq: 2}, {type: 'turn/start', seq: 1}]; }}});
  assert.equal(result.source, 'host');
});
for (const [name, mutate, pattern] of [
  ['运行中的原生会话', rows => rows.pop(), /仍在运行/],
  ['未配对工具调用', rows => rows.splice(3, 1), /未配对/],
  ['未知终止状态', rows => rows.splice(1), /无法确认/],
  ['错误会话身份', rows => { rows[0].payload.id = other; }, /身份与目标不一致/],
]) test('原生后备保护：' + name, async () => {
  const rows = idle(); mutate(rows);
  await fixture(rows, async ({codexHome}) => { await assert.rejects(inspectRollout({id, codexHome}), pattern); });
});
test('不存在的本地会话不被当成空闲', async () => {
  await fixture(idle(), async ({codexHome}) => { await assert.rejects(inspectRollout({id: other, codexHome}), /没有找到/); });
});
test('记录中存在未完成 JSON 行时拒绝重置', async () => {
  await fixture(idle(), async ({codexHome, file}) => {
    await fs.appendFile(file, '{"type":', 'utf8');
    await assert.rejects(inspectRollout({id, codexHome}), /未写完或无效/);
  });
});
