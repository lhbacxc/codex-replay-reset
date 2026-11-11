import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {arm, project, freshPolicy, validatePolicy, threadId} from '../core/policy.mjs';
import {createController, parseConfig, replaceBase, writeJson, readJson, localUrl} from '../core/controller.mjs';
import {createProxy} from '../bridge/server.mjs';
const id = '01900000-0000-7000-8000-000000000001', other = '01900000-0000-7000-8000-000000000002';
const history = () => ({model: 'synthetic-test', input: [
  {type: 'message', role: 'user', content: [{type: 'input_text', text: '中文历史'}]},
  {type: 'reasoning', id: 'rs_old', encrypted_content: 'synthetic-cipher-old', summary: []},
  {type: 'function_call', id: 'fc_old', call_id: 'call_keep', name: 'synthetic_tool', arguments: '{}'},
  {type: 'function_call_output', call_id: 'call_keep', output: 'synthetic-output'},
  {type: 'message', role: 'assistant', id: 'msg_old', content: [{type: 'output_text', text: 'synthetic-answer'}]},
  {type: 'message', role: 'user', content: [{type: 'input_text', text: '继续'}]},
]});
const marked = () => arm(freshPolicy(), id, randomUUID());
async function temp() { return fs.mkdtemp(path.join(os.tmpdir(), 'codex-replay-reset-test-')); }
async function cleanup(dir) {
  assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
  assert.ok(path.basename(dir).startsWith('codex-replay-reset-test-'));
  await fs.rm(dir, {recursive: true, force: true});
}
async function listen(server) { await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return server.address().port; }
async function close(server) { await new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }); }
test('未标记会话与其他会话完全透传', () => {
  const body = history();
  assert.equal(project(body, freshPolicy(), id).body, body);
  assert.equal(project(body, marked(), other).body, body);
});
test('捕获旧回放并保留文字、工具结果、call_id 和原对象', () => {
  const body = history(), saved = structuredClone(body);
  const result = project(body, marked(), id);
  assert.deepEqual(body, saved);
  assert.equal(result.body.input.some(x => x.type === 'reasoning'), false);
  assert.equal(result.body.input.find(x => x.type === 'function_call').call_id, 'call_keep');
  assert.equal(result.body.input.find(x => x.type === 'function_call').id, undefined);
  assert.equal(result.body.input.find(x => x.role === 'assistant').content[0].text, 'synthetic-answer');
  assert.deepEqual(result.body.input.find(x => x.type === 'function_call_output'), body.input[3]);
  assert.equal(result.policy.sessions[id].armed, false);
});
test('JSON 重载后持续识别旧指纹，新生成的回放保留', () => {
  const first = project(history(), marked(), id);
  const policy = validatePolicy(JSON.parse(JSON.stringify(first.policy)));
  const next = history();
  next.input.push({type: 'reasoning', id: 'rs_new', encrypted_content: 'synthetic-cipher-new', summary: []});
  next.input.push({type: 'message', role: 'assistant', id: 'msg_new', content: [{type: 'output_text', text: 'new'}]});
  const result = project(next, policy, id);
  assert.deepEqual(result.body.input.at(-2), next.input.at(-2));
  assert.equal(result.body.input.at(-1).id, 'msg_new');
  const persisted = JSON.stringify(result.policy);
  assert.equal(persisted.includes('synthetic-cipher'), false);
  assert.equal(persisted.includes('中文历史'), false);
  assert.equal(persisted.includes('synthetic-answer'), false);
});
test('重复 operation ID 幂等，重新点击能扩展捕获', () => {
  const op = randomUUID(), policy = arm(freshPolicy(), id, op);
  assert.equal(arm(policy, id, op), policy);
  assert.equal(arm(policy, id, randomUUID()).sessions[id].revision, 2);
});
for (const [name, change] of [
  ['上游引用', b => { b.previous_response_id = 'resp_old'; }],
  ['会话引用', b => { b.conversation = 'conv_old'; }],
  ['条目引用', b => b.input.push({type: 'item_reference', id: 'ref_old'})],
  ['加密压缩', b => b.input.push({type: 'compaction', encrypted_content: 'opaque-context'})],
  ['未配对工具调用', b => { b.input = b.input.filter(x => x.type !== 'function_call_output'); }],
  ['孤立工具结果', b => { b.input = b.input.filter(x => x.type !== 'function_call'); }],
]) test('拒绝不完整历史：' + name, () => {
  const body = history(); change(body);
  const before = structuredClone(body);
  assert.throws(() => project(body, marked(), id));
  assert.deepEqual(body, before);
});
test('真实 thread-id 优先于缓存 session-id；损坏策略拒绝加载', () => {
  assert.equal(threadId({'thread-id': id, 'session-id': other}), id);
  assert.equal(threadId({'session-id': id}), id);
  assert.equal(threadId({}), null);
  assert.throws(() => validatePolicy({version: 1, sessions: {[id]: {armed: true}}}));
});
test('TOML 定位与最小修改保留 UTF-8、CRLF、注释和其他供应商', async () => {
  const dir = await temp(), file = path.join(dir, 'config.toml');
  const raw = 'model_provider = "custom"\r\n# 中文规则\r\n[model_providers.other]\r\nbase_url = "http://127.0.0.1:9/v1"\r\nwire_api = "responses"\r\n[model_providers.custom]\r\nbase_url = "http://127.0.0.1:15721/v1" # 原路由\r\nwire_api = "responses"\r\nenv_key = "SYNTHETIC_KEY_NAME"\r\n';
  try {
    await fs.writeFile(file, raw, 'utf8');
    assert.equal(parseConfig(raw).url, 'http://127.0.0.1:15721/v1');
    await replaceBase(file, 'http://127.0.0.1:15721/v1', 'http://127.0.0.1:18761/v1');
    assert.equal(await fs.readFile(file, 'utf8'), raw.replace('15721', '18761'));
    await assert.rejects(replaceBase(file, 'wrong', 'http://127.0.0.1:1/v1'));
    await replaceBase(file, 'http://127.0.0.1:18761/v1', 'http://127.0.0.1:15721/v1');
    assert.equal(await fs.readFile(file, 'utf8'), raw);
    assert.throws(() => localUrl('https://example.com/v1', 18761));
    assert.throws(() => localUrl('http://127.0.0.1:18761/v1', 18761));
  } finally { await cleanup(dir); }
});
test('HTTP 透传、旧回放清理、SSE、控制鉴权和上游错误', async () => {
  const dir = await temp(); let lastBody, lastPath, lastAuth;
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    lastBody = Buffer.concat(chunks).toString('utf8'); lastPath = req.url; lastAuth = req.headers.authorization;
    if (req.url.includes('error=1')) {
      res.writeHead(400, {'content-type': 'application/json'}); res.end(JSON.stringify({error: {message: 'Different Azure OpenAI resource'}})); return;
    }
    res.writeHead(200, {'content-type': 'text/event-stream', 'x-synthetic-test': 'pass'});
    res.write('data: {"type":"response.created"}\n\n');
    setTimeout(() => res.end('data: {"type":"response.completed"}\n\n'), 15);
  });
  let proxy;
  try {
    const upstreamPort = await listen(upstream), token = 'a'.repeat(64);
    const conn = {version: 1, enabled: true, upstream: 'http://127.0.0.1:' + upstreamPort + '/v1', port: 0, token};
    await writeJson(path.join(dir, 'connection.json'), conn);
    proxy = await createProxy({runtimeDir: dir, port: 0});
    const proxyPort = proxy.server.address().port, base = 'http://127.0.0.1:' + proxyPort;
    await writeJson(path.join(dir, 'connection.json'), {...conn, port: proxyPort});
    const send = (body, suffix = '') => fetch(base + '/v1/responses' + suffix, {method: 'POST',
      headers: {'content-type': 'application/json', 'thread-id': id, authorization: 'Bearer SYNTHETIC_ONLY'}, body});
    const control = (action, args, supplied = token) => fetch(base + '/_replay/' + action, {method: 'POST',
      headers: {'content-type': 'application/json', 'x-replay-control': supplied}, body: JSON.stringify(args)});
    const raw = JSON.stringify(history(), null, 2);
    const first = await send(raw); const stream = await first.text();
    assert.equal(lastBody, raw); assert.equal(lastPath, '/v1/responses'); assert.equal(lastAuth, 'Bearer SYNTHETIC_ONLY');
    assert.equal(first.headers.get('x-synthetic-test'), 'pass');
    assert.ok(stream.includes('response.created') && stream.includes('response.completed'));
    assert.equal((await control('arm', {sessionId: id, operationId: randomUUID()}, 'bad')).status, 403);
    assert.equal((await control('arm', {sessionId: id, operationId: randomUUID()})).status, 200);
    const reset = await send(raw); await reset.text();
    assert.equal(JSON.parse(lastBody).input.some(x => x.type === 'reasoning'), false);
    assert.equal(JSON.parse(lastBody).input.find(x => x.type === 'function_call').call_id, 'call_keep');
    const policy = await readJson(path.join(dir, 'policy.json'));
    assert.equal(policy.sessions[id].armed, false);
    assert.equal(JSON.stringify(policy).includes('synthetic-cipher'), false);
    const failure = await send(raw, '?error=1');
    assert.equal(failure.status, 400); assert.match(await failure.text(), /Different Azure/);
    assert.equal((await fetch(base + '/_replay/status')).status, 403);
    assert.equal((await fetch(base + '/v1/models', {headers: {origin: 'https://example.com'}})).status, 403);
  } finally { if (proxy) await proxy.close(); await close(upstream); await cleanup(dir); }
});
test('实际 Node 后台接入、CC Switch 重写维护、解除、停止均可恢复', async () => {
  const dir = await temp(), configDir = path.join(dir, 'codex');
  await fs.mkdir(configDir);
  const upstream = http.createServer((_req, res) => res.end('{}'));
  const reserve = http.createServer(), port = await listen(reserve); await close(reserve);
  const upstreamPort = await listen(upstream), url = 'http://127.0.0.1:' + upstreamPort + '/v1';
  const file = path.join(configDir, 'config.toml'), raw = 'model_provider = "custom"\n# 中文配置\n[model_providers.custom]\nbase_url = "' + url + '"\nwire_api = "responses"\n';
  const controller = createController({runtimeDir: path.join(dir, 'runtime'), codexHome: configDir, config: {port}});
  try {
    await fs.writeFile(file, raw, 'utf8');
    const attached = await controller.attach();
    assert.equal(attached.ready, true); assert.equal(attached.attached, true);
    assert.equal(parseConfig(await fs.readFile(file, 'utf8')).url, 'http://127.0.0.1:' + port + '/v1');
    await fs.writeFile(file, raw, 'utf8'); await controller.maintain();
    assert.equal((await controller.status()).attached, true);
    await controller.detach(); assert.equal(await fs.readFile(file, 'utf8'), raw);
    await controller.attach(); await controller.stop();
    assert.equal(await fs.readFile(file, 'utf8'), raw);
    assert.equal((await controller.status()).enabled, false);
  } finally { await controller.stop().catch(() => {}); await close(upstream); await cleanup(dir); }
});
