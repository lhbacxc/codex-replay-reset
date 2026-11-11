import {createHash} from 'node:crypto';
export const validId = x => typeof x === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(x);
export function canonical(x) {
  if (x === null || typeof x !== 'object') return JSON.stringify(x);
  if (Array.isArray(x)) return '[' + x.map(canonical).join(',') + ']';
  return '{' + Object.keys(x).sort().filter(k => x[k] !== undefined).map(k => JSON.stringify(k) + ':' + canonical(x[k])).join(',') + '}';
}
export const digest = x => createHash('sha256').update(canonical(x)).digest('hex');
export function threadId(headers) {
  // Codex 原生分别发送 thread-id（真实会话）与 session-id（缓存亲和性）。
  for (const key of ['thread-id', 'x-codex-thread-id', 'session-id', 'session_id']) {
    if (validId(headers[key])) return headers[key];
  }
  return null;
}
export function freshPolicy() { return {version: 1, sessions: {}}; }
export function validatePolicy(p) {
  if (!p || p.version !== 1 || !p.sessions || typeof p.sessions !== 'object' || Array.isArray(p.sessions)) throw Error('重置策略格式无效');
  if (Object.keys(p.sessions).length > 4096) throw Error('重置会话数量超过上限');
  for (const [id, s] of Object.entries(p.sessions)) {
    if (!validId(id) || !s || typeof s.armed !== 'boolean' || !Number.isSafeInteger(s.revision) ||
        !Array.isArray(s.remove) || !Array.isArray(s.strip) || s.remove.length + s.strip.length > 100000 ||
        ![...s.remove, ...s.strip].every(x => /^[a-f0-9]{64}$/.test(x))) throw Error('重置策略会话记录无效');
  }
  return p;
}
const calls = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'shell_call', 'computer_call', 'apply_patch_call']);
const results = new Set(['function_call_output', 'custom_tool_call_output', 'local_shell_call_output', 'shell_call_output', 'computer_call_output', 'apply_patch_call_output']);
function assertComplete(body) {
  if (!Array.isArray(body.input) || !body.input.length) throw Error('请求没有可展开的完整历史，未重置');
  if (body.previous_response_id || body.conversation) throw Error('请求依赖上游会话引用；请恢复完整历史的 HTTP 会话后再重置');
  const pending = new Set();
  for (const item of body.input) {
    if (!item || typeof item !== 'object') throw Error('历史条目格式无效');
    if (item.type === 'item_reference') throw Error('历史包含无法展开的条目引用，未重置');
    if (item.type === 'compaction' && item.encrypted_content) throw Error('历史包含加密压缩上下文，无法无损重置；请使用有完整历史的会话');
    if (calls.has(item.type)) {
      if (!item.call_id || pending.has(item.call_id)) throw Error('历史工具调用标识无效');
      pending.add(item.call_id);
    } else if (results.has(item.type)) {
      if (!pending.delete(item.call_id)) throw Error('历史工具结果缺少配对调用，未重置');
    }
  }
  if (pending.size) throw Error('历史工具调用缺少结果；请先结束或恢复原轮次');
}
export function arm(policy, id, operationId) {
  if (!validId(id) || !validId(operationId)) throw Error('会话或操作标识无效');
  const old = Object.hasOwn(policy.sessions, id) ? policy.sessions[id] : null;
  if (old?.operationId === operationId) return policy;
  return {...policy, sessions: {...policy.sessions, [id]: {
    armed: true, revision: (old?.revision || 0) + 1, remove: old?.remove || [], strip: old?.strip || [],
    operationId, markedAt: Date.now(), capturedAt: null, modifiedRequests: old?.modifiedRequests || 0,
  }}};
}
export function project(body, policy, id) {
  const record = id && Object.hasOwn(policy.sessions, id) ? policy.sessions[id] : null;
  if (!record) return {body, policy, changed: false};
  const remove = new Set(record.remove), strip = new Set(record.strip);
  if (record.armed) {
    assertComplete(body);
    for (const item of body.input) {
      if (item.type === 'reasoning') remove.add(digest(item));
      else if (item.id && (item.type === 'message' || !item.type && item.role || calls.has(item.type) || results.has(item.type))) strip.add(digest(item));
    }
  }
  let changed = false;
  const input = Array.isArray(body.input) ? body.input.flatMap(item => {
    const key = digest(item);
    if (remove.has(key)) { changed = true; return []; }
    if (strip.has(key) && item.id) { const {id: _id, ...copy} = item; changed = true; return [copy]; }
    return [item];
  }) : body.input;
  // 已标记历史遇到引用式续聊时拒绝；不凭空删除 previous_response_id 丢失上下文。
  if ((remove.size || strip.size) && (body.previous_response_id || body.conversation)) assertComplete(body);
  const next = {...record, armed: false, remove: [...remove], strip: [...strip],
    capturedAt: record.armed ? Date.now() : record.capturedAt,
    modifiedRequests: (record.modifiedRequests || 0) + (changed ? 1 : 0)};
  return {body: changed ? {...body, input} : body, policy: {...policy, sessions: {...policy.sessions, [id]: next}}, changed};
}
