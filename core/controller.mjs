import fs from 'node:fs/promises';
import {existsSync} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {randomBytes, randomUUID} from 'node:crypto';
import {spawn} from 'node:child_process';
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const defaultRuntime = path.join(packageRoot, '.runtime');
export async function readJson(file, fallback) {
  try { return JSON.parse(await fs.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw Error('本地状态读取失败，已停止操作'); }
}
export async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), {recursive: true});
  const temp = file + '.' + randomUUID() + '.tmp';
  try { await fs.writeFile(temp, JSON.stringify(value, null, 2) + '\n', {encoding: 'utf8', mode: 0o600}); await fs.rename(temp, file); }
  finally { await fs.rm(temp, {force: true}); }
}
export function localUrl(value, ownPort) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || Number(url.port || 80) === Number(ownPort)) throw Error('上游必须是与清理代理端口不同的本地 CC Switch HTTP 地址');
  if (url.pathname.replace(/\/$/, '') !== '/v1') throw Error('当前仅支持 CC Switch 的 /v1 Responses 路由');
  return url.toString().replace(/\/$/, '');
}
export function parseConfig(text) {
  const firstTable = text.search(/^\s*\[/m);
  const top = firstTable < 0 ? text : text.slice(0, firstTable);
  const selected = top.match(/^\s*model_provider\s*=\s*["']([a-zA-Z0-9_-]+)["']/m)?.[1];
  if (!selected) throw Error('未找到可识别的 Codex model_provider');
  const escaped = selected.replace(/[.*+?^\x24{}()|[\]\\]/g, '\\$&');
  const table = new RegExp('^\\s*\\[model_providers\\.(?:' + escaped + '|"' + escaped + '")\\]\\s*(?:#.*)?$', 'm');
  const hit = table.exec(text);
  if (!hit) throw Error('未找到当前供应商的配置表');
  const start = hit.index + hit[0].length;
  const rest = text.slice(start), next = rest.search(/^\s*\[/m);
  const body = next < 0 ? rest : rest.slice(0, next);
  if (!/^\s*wire_api\s*=\s*["']responses["']/m.test(body)) throw Error('当前供应商不是 Responses 协议');
  const base = /^([ \t]*base_url[ \t]*=[ \t]*)(["'])([^"'\r\n]+)\2/m.exec(body);
  if (!base) throw Error('未找到当前供应商的 base_url');
  return {provider: selected, url: base[3], offset: start + base.index + base[1].length, length: base[2].length * 2 + base[3].length};
}
export async function replaceBase(configPath, expected, installed) {
  const raw = await fs.readFile(configPath, 'utf8'), found = parseConfig(raw);
  if (found.url !== expected) throw Error('连接配置已被其他程序修改，请重新检查接入');
  const next = raw.slice(0, found.offset) + JSON.stringify(installed) + raw.slice(found.offset + found.length);
  const temp = configPath + '.replay-reset-' + randomUUID() + '.tmp';
  try {
    await fs.writeFile(temp, next, {encoding: 'utf8', mode: 0o600});
    if (await fs.readFile(configPath, 'utf8') !== raw) throw Error('配置发生并发修改，本次未覆盖');
    await fs.rename(temp, configPath);
  } finally { await fs.rm(temp, {force: true}); }
}
export function createController({runtimeDir = defaultRuntime, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), config = {}} = {}) {
  const connectionFile = path.join(runtimeDir, 'connection.json');
  const configPath = path.join(codexHome, 'config.toml');
  const port = Number(config.port || 18761);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('代理端口无效');
  const endpoint = 'http://127.0.0.1:' + port + '/v1';
  let queue = Promise.resolve();
  const serial = fn => { const p = queue.then(fn); queue = p.catch(() => {}); return p; };
  const connection = () => readJson(connectionFile, null);
  async function current() { return parseConfig(await fs.readFile(configPath, 'utf8')); }
  async function call(method, args = {}, state) {
    state ||= await connection();
    if (!state) throw Error('代理尚未接入');
    const response = await fetch('http://127.0.0.1:' + state.port + '/_replay/' + method, {
      method: method === 'status' ? 'GET' : 'POST',
      headers: {'content-type': 'application/json', 'x-replay-control': state.token},
      ...(method === 'status' ? {} : {body: JSON.stringify(args)}), signal: AbortSignal.timeout(4000),
    });
    const result = await response.json();
    if (!response.ok) throw Error(typeof result.error === 'string' ? result.error : result.error?.message || '代理操作失败');
    return result;
  }
  async function start(state) {
    try { await call('status', {}, state); return; } catch {}
    const child = spawn(process.execPath, [path.join(packageRoot, 'bridge/server.mjs'), runtimeDir], {
      detached: true, stdio: 'ignore', windowsHide: true,
    });
    let spawnError;
    child.on('error', () => { spawnError = true; });
    child.unref();
    for (let i = 0; i < 35; i++) {
      if (spawnError) throw Error('无法启动 Node 清理代理');
      await new Promise(resolve => setTimeout(resolve, 100));
      try { await call('status', {}, state); return; } catch {}
    }
    throw Error('代理未能启动；请检查端口是否被占用');
  }
  async function status() {
    const state = await connection(), found = await current();
    let live = null;
    if (state) { try { live = await call('status', {}, state); } catch {} }
    return {ready: !!live, attached: !!state && state.enabled && found.provider === state.provider && found.url === state.endpoint,
      endpoint: state?.endpoint || endpoint, upstream: state?.upstream || found.url, provider: found.provider,
      enabled: !!state?.enabled, runningRequests: live?.runningRequests || 0, sessions: live?.sessions || [],
      configChanged: !!state && state.enabled && found.url !== state.endpoint, reloadRequired: !!state?.enabled,
      lastError: state?.lastError || null};
  }
  async function attach() {
    const found = await current(), old = await connection();
    if (old && found.url === old.endpoint) {
      if (old.port !== port) throw Error('请先解除原端口接入，再更改端口');
      await start(old); if (!old.enabled) await writeJson(connectionFile, {...old, enabled: true}); return status();
    }
    const upstream = localUrl(found.url, port);
    const state = {version: 1, enabled: false, provider: found.provider, configPath, upstream, endpoint, port,
      token: old?.token || randomBytes(32).toString('hex'), attachedAt: Date.now()};
    await writeJson(connectionFile, state);
    await start(state);
    const enabled = {...state, enabled: true};
    try { await replaceBase(configPath, found.url, endpoint); await writeJson(connectionFile, enabled); }
    catch (error) { await writeJson(connectionFile, {...state, lastError: error.message}); throw error; }
    return status();
  }
  async function detach() {
    const state = await connection();
    if (!state) return status();
    const live = await call('status', {}, state).catch(() => null);
    if (live?.runningRequests) throw Error('代理仍有运行中的请求，请结束后解除接入');
    const found = await current();
    if (found.url === state.endpoint) {
      if (found.provider !== state.provider) throw Error('供应商身份已变化，未覆盖配置');
      await replaceBase(configPath, state.endpoint, state.upstream);
    }
    await writeJson(connectionFile, {...state, enabled: false});
    // 保留透传服务供仍使用旧地址的已打开会话结束；退出 Codex 后可停止代理。
    return status();
  }
  async function maintain() {
    const state = await connection();
    if (!state?.enabled) return;
    const found = await current();
    if (found.provider === state.provider && found.url === state.upstream) {
      await replaceBase(configPath, state.upstream, state.endpoint);
    } else if (found.provider !== state.provider || found.url !== state.endpoint) {
      await writeJson(connectionFile, {...state, enabled: false, lastError: 'CC Switch 改变了供应商或地址，请在拓展中重新接入'});
    }
  }
  return {runtimeDir, connection, call, status, maintain: () => serial(maintain),
    attach: () => serial(attach), detach: () => serial(detach),
    async resume() { const state = await connection(); if (state?.enabled) { await start(state); await serial(maintain); } },
    async stop() { await serial(detach); const state = await connection(); if (state && (await status()).ready) await call('stop', {}, state); return true; },
    async arm(args) { return call('arm', args); }, async clear(args) { return call('clear', args); }};
}
