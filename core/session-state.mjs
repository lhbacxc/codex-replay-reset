import fs from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import readline from 'node:readline';
import {validId} from './policy.mjs';
export const defaultCodexHome = () => process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const missing = error => /没有找到会话|未找到会话|session.{0,30}not found|not found.{0,30}session/i.test(String(error?.message || error));
async function findRollout(codexHome, id) {
  const matches = []; let visited = 0;
  for (const directory of ['sessions', 'archived_sessions']) {
    const root = path.resolve(codexHome, directory), queue = [root];
    while (queue.length) {
      if (++visited > 50000) throw Error('本地会话目录过多，未完成安全检查');
      const current = queue.pop();
      let entries;
      try { entries = await fs.readdir(current, {withFileTypes: true}); }
      catch (error) { if (error.code === 'ENOENT') continue; throw Error('无法读取本地会话目录，未重置'); }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const file = path.resolve(current, entry.name);
        if (file !== root && !file.startsWith(root + path.sep)) throw Error('会话文件路径越界');
        if (entry.isDirectory()) queue.push(file);
        else if (entry.isFile() && entry.name.toLowerCase().endsWith('-' + id.toLowerCase() + '.jsonl')) matches.push({file, root});
      }
    }
  }
  if (!matches.length) throw Error('没有找到对应的本地会话记录，未重置');
  if (matches.length !== 1) throw Error('存在多个同身份会话文件，请先核对记录，未重置');
  const match = matches[0], real = await fs.realpath(match.file), realRoot = await fs.realpath(match.root);
  if (!real.startsWith(realRoot + path.sep)) throw Error('会话文件指向数据目录之外，未重置');
  return real;
}
const callTypes = new Set(['function_call', 'custom_tool_call', 'local_shell_call', 'shell_call', 'computer_call', 'apply_patch_call']);
const resultTypes = new Set([...callTypes].map(type => type + '_output'));
export async function inspectRollout({id, codexHome = defaultCodexHome()}) {
  if (!validId(id)) throw Error('会话标识无效');
  const file = await findRollout(codexHome, id), before = await fs.stat(file);
  if (before.size > 512 * 1024 * 1024) throw Error('会话记录超过安全检查体积上限');
  const input = createReadStream(file, {encoding: 'utf8'});
  const lines = readline.createInterface({input, crlfDelay: Infinity});
  let identity = null, terminal = null, records = 0;
  const turns = new Set(), pending = new Set();
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let row;
      try { row = JSON.parse(line); } catch { throw Error('本地会话包含未写完或无效记录，未重置'); }
      records++;
      if (row.type === 'session_meta') {
        if (identity) throw Error('本地会话身份记录重复，未重置');
        identity = row.payload?.id;
        if (typeof identity !== 'string' || identity.toLowerCase() !== id.toLowerCase()) throw Error('会话文件中的身份与目标不一致，未重置');
      }
      if (row.type === 'event_msg') {
        const event = row.payload, turn = event?.turn_id || 'legacy-turn';
        if (event?.type === 'task_started') { turns.add(turn); terminal = 'running'; }
        else if (event?.type === 'task_complete' || event?.type === 'turn_aborted') {
          turns.delete(turn); terminal = event.type;
        }
      }
      if (row.type === 'response_item') {
        const item = row.payload;
        if (callTypes.has(item?.type)) {
          if (typeof item.call_id !== 'string' || !item.call_id || pending.has(item.call_id)) throw Error('本地会话工具调用标识无效，未重置');
          pending.add(item.call_id);
        } else if (resultTypes.has(item?.type)) {
          if (!pending.delete(item.call_id)) throw Error('本地会话工具结果没有配对调用，未重置');
        }
      }
    }
  } finally { lines.close(); input.destroy(); }
  const after = await fs.stat(file);
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || before.ino !== after.ino) throw Error('会话记录正在变化，请等待当前轮次结束后重试');
  if (!identity || !records) throw Error('本地会话身份或记录为空，未重置');
  if (turns.size || terminal === 'running') throw Error('目标会话仍在运行，请等待当前轮次结束');
  if (!terminal) throw Error('无法确认本地会话已结束，未重置');
  if (pending.size) throw Error('目标会话仍有未配对的工具调用，请先恢复或结束原轮次');
  return {source: 'rollout', id: identity, idle: true, terminal, records};
}
export async function assertSessionIdle({id, sessionQuery, codexHome = defaultCodexHome()}) {
  if (!validId(id)) throw Error('会话标识无效');
  if (sessionQuery) {
    let result;
    try { result = await sessionQuery.listEvents(id, {types: ['turn/start', 'turn/complete', 'turn/aborted'], fromEnd: true, limit: 20}); }
    catch (error) { if (!missing(error)) throw Error('宿主会话状态查询失败，未重置'); }
    if (result !== undefined) {
      const events = Array.isArray(result) ? result : result?.events || result?.items;
      if (!Array.isArray(events)) throw Error('宿主会话状态格式无法识别，未重置');
      const last = [...events].sort((a, b) => a.seq - b.seq).at(-1);
      if (last?.type === 'turn/start') throw Error('目标会话仍在运行，请等待当前轮次结束');
      if (last?.type === 'turn/complete' || last?.type === 'turn/aborted') return {source: 'host', id, idle: true};
    }
  }
  return inspectRollout({id, codexHome});
}
