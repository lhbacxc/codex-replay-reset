import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {timingSafeEqual} from 'node:crypto';
import {readJson, writeJson, localUrl, createController} from '../core/controller.mjs';
import {freshPolicy, validatePolicy, project, arm, threadId, validId} from '../core/policy.mjs';
const hop = new Set(['host', 'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade']);
function forwardHeaders(headers) {
  const excluded = new Set(hop);
  for (const name of String(headers.connection || '').split(',')) excluded.add(name.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !excluded.has(key.toLowerCase()) && !key.toLowerCase().startsWith('x-replay-')));
}
function json(res, status, data) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store'});
  res.end(JSON.stringify(data));
}
async function bodyOf(req, max = 128 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const part of req) { size += part.length; if (size > max) throw Error('请求超过清理代理的体积上限'); chunks.push(part); }
  return Buffer.concat(chunks);
}
function validToken(value, token) {
  return typeof value === 'string' && typeof token === 'string' && /^[a-f0-9]{64}$/.test(value) && /^[a-f0-9]{64}$/.test(token) &&
    timingSafeEqual(Buffer.from(value), Buffer.from(token));
}
export async function createProxy({runtimeDir, port, maintain = false}) {
  const policyFile = path.join(runtimeDir, 'policy.json'), connectionFile = path.join(runtimeDir, 'connection.json');
  let policy = validatePolicy(await readJson(policyFile, freshPolicy()));
  const active = new Map();
  let identifiedRequests = 0, unidentifiedRequests = 0;
  let chain = Promise.resolve();
  const serial = fn => { const result = chain.then(fn); chain = result.catch(() => {}); return result; };
  const running = () => [...active.values()].reduce((a, b) => a + b, 0);
  const server = http.createServer(async (req, res) => {
    try {
      const state = await readJson(connectionFile, null);
      if (!state || state.version !== 1) throw Error('代理连接状态无效');
      if (req.headers.origin) return json(res, 403, {error: '此代理只接受本地原生客户端请求'});
      const requestUrl = new URL(req.url, 'http://127.0.0.1');
      if (requestUrl.pathname.startsWith('/_replay/')) {
        if (!validToken(req.headers['x-replay-control'], state.token)) return json(res, 403, {error: '代理控制凭证无效'});
        const action = requestUrl.pathname.slice('/_replay/'.length);
        if (action === 'status' && req.method === 'GET') return json(res, 200, {
          runningRequests: running(), identifiedRequests, unidentifiedRequests,
          sessions: Object.entries(policy.sessions).map(([id, s]) => ({id, armed: s.armed, revision: s.revision,
            resetCount: s.remove.length + s.strip.length, markedAt: s.markedAt, capturedAt: s.capturedAt, modifiedRequests: s.modifiedRequests || 0})),
        });
        if (req.method !== 'POST') return json(res, 405, {error: '请求方法不支持'});
        const args = JSON.parse((await bodyOf(req, 8192)).toString('utf8') || '{}');
        await serial(async () => {
          if (action === 'arm' || action === 'clear') {
            if (!validId(args.sessionId)) throw Error('会话标识无效');
            if (active.get(args.sessionId)) throw Error('当前会话仍有运行中的模型请求，请稍后重试');
            if (action === 'arm') {
              if (!state.enabled) throw Error('请先接入清理代理，再标记旧回放');
              const next = validatePolicy(arm(policy, args.sessionId, args.operationId));
              await writeJson(policyFile, next); policy = next;
            } else {
              const sessions = {...policy.sessions}; delete sessions[args.sessionId];
              const next = {...policy, sessions}; await writeJson(policyFile, next); policy = next;
            }
          } else if (action === 'stop') {
            if (running()) throw Error('仍有运行中的模型请求，无法停止代理');
            setImmediate(() => { server.close(); server.closeIdleConnections(); });
          } else throw Error('未知代理操作');
        });
        return json(res, 200, {ok: true, armed: action === 'arm', pendingCapture: action === 'arm'});
      }
      if (!requestUrl.pathname.startsWith('/v1/') || requestUrl.pathname.includes('..')) return json(res, 404, {error: '接口不存在'});
      if (!['GET', 'POST'].includes(req.method)) return json(res, 405, {error: '请求方法不支持'});
      const upstream = new URL(localUrl(state.upstream, port));
      const targetPath = upstream.pathname.replace(/\/$/, '') + requestUrl.pathname.slice(3) + requestUrl.search;
      let body = await bodyOf(req);
      const sessionId = threadId(req.headers);
      const generation = req.method === 'POST' && requestUrl.pathname === '/v1/responses';
      const activeKey = sessionId || 'unidentified';
      if (generation) {
        if (sessionId) identifiedRequests++; else unidentifiedRequests++;
        active.set(activeKey, (active.get(activeKey) || 0) + 1);
        let done = false;
        const finish = () => {
          if (done) return; done = true;
          const count = (active.get(activeKey) || 1) - 1;
          if (count) active.set(activeKey, count); else active.delete(activeKey);
        };
        res.once('close', finish); res.once('finish', finish);
        if (state.enabled) {
          await serial(async () => {
            if (!sessionId && Object.values(policy.sessions).some(s => s.armed)) throw Error('此请求未携带可识别的会话 ID，未执行重置；请检查 Codex 版本');
            const record = sessionId && Object.hasOwn(policy.sessions, sessionId) ? policy.sessions[sessionId] : null;
            if (!record) return;
            if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') throw Error('重置暂不支持压缩请求体');
            const result = project(JSON.parse(body.toString('utf8')), policy, sessionId);
            await writeJson(policyFile, result.policy); policy = result.policy;
            if (result.changed) body = Buffer.from(JSON.stringify(result.body), 'utf8');
          });
        }
      }
      const headers = forwardHeaders(req.headers);
      headers.host = upstream.host;
      if (body.length || req.method === 'POST') headers['content-length'] = String(body.length);
      else delete headers['content-length'];
      const proxy = http.request({hostname: upstream.hostname === '[::1]' ? '::1' : upstream.hostname,
        port: upstream.port || 80, path: targetPath, method: req.method, headers}, response => {
        res.writeHead(response.statusCode || 502, forwardHeaders(response.headers));
        response.on('error', () => res.destroy());
        response.pipe(res);
      });
      res.once('close', () => { if (!res.writableFinished) proxy.destroy(); });
      proxy.setTimeout(600000, () => proxy.destroy(Error('timeout')));
      proxy.on('error', () => {
        if (!res.headersSent) json(res, 502, {error: {message: '无法连接 CC Switch 路由，请检查它是否已启动', type: 'replay_proxy_connection_error'}});
        else res.destroy();
      });
      proxy.end(body);
    } catch (error) {
      json(res, 409, {error: {message: error.message || '回放清理未完成', type: 'replay_reset_error'}});
    }
  });
  // WebSocket 返回明确的不支持信号，让支持回退的 Codex 使用完整历史 HTTP 请求。
  server.on('upgrade', (_req, socket) => socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'));
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  let timer;
  if (maintain) {
    const state = await readJson(connectionFile, null);
    const controller = createController({runtimeDir, codexHome: path.dirname(state.configPath), config: {port}});
    timer = setInterval(() => controller.maintain().catch(() => {}), 5000);
    timer.unref();
  }
  server.once('close', () => { if (timer) clearInterval(timer); });
  return {server, close: () => new Promise(resolve => { server.close(resolve); server.closeIdleConnections(); })};
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const runtimeDir = process.argv[2];
  try {
    const state = await readJson(path.join(runtimeDir, 'connection.json'), null);
    await createProxy({runtimeDir, port: state.port, maintain: true});
  } catch { process.exitCode = 1; }
}
