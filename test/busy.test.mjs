import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import {randomUUID} from 'node:crypto';
import {createProxy} from '../bridge/server.mjs';
import {writeJson} from '../core/controller.mjs';
test('流式请求期间禁止重置，取消后释放维护锁', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-replay-reset-test-'));
  const id = '01900000-0000-7000-8000-000000000001', token = 'b'.repeat(64);
  let responseClosed;
  const closed = new Promise(resolve => { responseClosed = resolve; });
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, {'content-type': 'text/event-stream'});
    res.write('data: {"type":"response.created"}\n\n');
    res.once('close', responseClosed);
  });
  let proxy;
  try {
    await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
    const state = {version: 1, enabled: true, token, port: 0, upstream: 'http://127.0.0.1:' + upstream.address().port + '/v1'};
    await writeJson(path.join(dir, 'connection.json'), state);
    proxy = await createProxy({runtimeDir: dir, port: 0});
    const base = 'http://127.0.0.1:' + proxy.server.address().port;
    const abort = new AbortController();
    const response = await fetch(base + '/v1/responses', {method: 'POST', signal: abort.signal,
      headers: {'content-type': 'application/json', 'thread-id': id},
      body: JSON.stringify({model: 'synthetic', input: [{role: 'user', content: 'synthetic'}]})});
    const busy = await fetch(base + '/_replay/arm', {method: 'POST',
      headers: {'content-type': 'application/json', 'x-replay-control': token},
      body: JSON.stringify({sessionId: id, operationId: randomUUID()})});
    assert.equal(busy.status, 409);
    assert.match((await busy.json()).error.message, /运行/);
    abort.abort(); await response.body.cancel().catch(() => {});
    await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(Error('上游取消未传播')), 2000))]);
    const idle = await fetch(base + '/_replay/status', {headers: {'x-replay-control': token}});
    assert.equal((await idle.json()).runningRequests, 0);
  } finally {
    if (proxy) await proxy.close();
    await new Promise(resolve => { upstream.close(resolve); upstream.closeAllConnections(); });
    assert.equal(path.dirname(path.resolve(dir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dir).startsWith('codex-replay-reset-test-'));
    await fs.rm(dir, {recursive: true, force: true});
  }
});
