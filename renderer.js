codexPlus.extension((ctx) => {
  const ID = 'codex-replay-reset';
  let connection = {attached: false, ready: false, sessions: []}, working = false;
  const surfaces = new Set(), runningSessions = new Set();
  const node = (tag, text) => {
    const element = document.createElement(tag);
    element.dataset.codexPlusExt = ID;
    if (text !== undefined) element.textContent = text;
    return element;
  };
  function currentId() {
    const ids = new Set([...document.querySelectorAll('[data-response-annotation-conversation]')]
      .filter(el => el.getClientRects().length)
      .map(el => el.getAttribute('data-response-annotation-conversation'))
      .filter(id => /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id)));
    return ids.size === 1 ? [...ids][0] : null;
  }
  function currentRunning() {
    const button = document.querySelector('[data-composer-surface-overflow] button.bg-composer-primary');
    return /停止|stop|排队|queue/i.test(button?.getAttribute('aria-label') || '');
  }
  function paint() {
    for (const surface of [...surfaces]) {
      if (!surface.root.isConnected) { surfaces.delete(surface); continue; }
      if (surface.status) surface.status.textContent = connection.attached ? 'CC Switch 清理代理已接入' : '尚未接入清理代理';
      if (surface.reset) surface.reset.disabled = working || !connection.attached || currentRunning() || !currentId();
    }
  }
  async function refresh() {
    connection = await ctx.backend.call('status');
    paint(); return connection;
  }
  const friendlyError = error => String(error?.message || '操作未完成').replace(/^Error:\\s*/, '').replace(/\\s+at\\s+[\\w.<\\[]+[\\s\\S]*$/, '').slice(0, 500);
  async function perform(action) {
    if (working) return;
    working = true; paint();
    try { return await action(); }
    catch (error) { ctx.toast(friendlyError(error), {type: 'error'}); }
    finally { working = false; paint(); }
  }
  async function reset(sessionId) {
    return perform(async () => {
      if (!sessionId) { panel.open(); ctx.toast('请从会话行的更多操作中重置目标会话', {type: 'info'}); return; }
      if (runningSessions.has(sessionId) || sessionId === currentId() && currentRunning()) throw Error('请先等待当前轮次和工具调用结束');
      const state = await refresh();
      if (!state.attached) { panel.open(); throw Error('请先接入清理代理'); }
      await ctx.backend.call('arm', {sessionId, operationId: crypto.randomUUID()});
      await refresh();
      ctx.toast('旧回放重置已标记。下一条正常消息将捕获并清理旧回放；聊天记录保留。', {type: 'success'});
    });
  }
  const panel = ctx.registerSidePanel({
    title: '旧回放重置', icon: '↻', width: 390,
    render: ({container}) => {
      container.replaceChildren();
      const root = node('section'); root.className = 'replay-reset-panel';
      root.append(node('h2', '保留历史，恢复续聊'));
      root.append(node('p', '用于 AgentRouter 上游资源切换后的 Different Azure OpenAI resource 错误。请求经本地清理代理，再交给 CC Switch 路由。'));
      const status = node('p', '正在检查接入…');
      const details = node('p'), actions = node('div'); actions.className = 'replay-reset-actions';
      const resetButton = node('button', '重置当前会话旧回放');
      resetButton.onclick = () => reset(currentId());
      const addButton = (label, run) => {
        const button = node('button', label);
        button.onclick = () => perform(async () => { await run(); await update(); });
        actions.append(button); return button;
      };
      addButton('检查接入', () => refresh());
      addButton('接入清理代理', async () => {
        await ctx.backend.call('attach');
        ctx.toast('接入已保存。首次接入后，请通过 Codex++ 重启 Codex，再恢复原会话。', {type: 'success'});
      });
      addButton('解除接入', async () => {
        await ctx.backend.call('detach');
        ctx.toast('连接已恢复到 CC Switch。重新启动 Codex 后完整生效。', {type: 'success'});
      });
      addButton('停止清理代理', async () => {
        await ctx.backend.call('stop');
        ctx.toast('代理已停止；请重新启动 Codex，使会话使用恢复后的地址。', {type: 'info'});
      });
      const records = node('div');
      root.append(status, details, resetButton, actions,
        node('p', '首次接入需重启 Codex 并恢复原会话。点击重置只标记，不发送消息或重跑工具。CC Switch 如改变供应商或地址，需要重新接入。'),
        node('h3', '已标记会话'), records,
        node('p', '仅重置所选会话，子代理和独立分叉分别操作。完整历史缺失、工具结果未配对或存在加密压缩上下文时会拒绝清理。'));
      container.append(root);
      const surface = {root, status, reset: resetButton}; surfaces.add(surface);
      async function update() {
        const state = await refresh();
        if (!root.isConnected) return;
        details.textContent = '清理入口：' + state.endpoint + '\nCC Switch：' + state.upstream + (state.lastError ? '\n' + state.lastError : '');
        records.replaceChildren();
        for (const record of state.sessions) {
          const row = node('div'); row.className = 'replay-reset-record';
          row.append(node('code', record.id), node('span', record.armed ? '等待下一条消息捕获旧回放' : '已标记 ' + record.resetCount + ' 条；清理请求 ' + record.modifiedRequests + ' 次'));
          const clear = node('button', '撤销此会话标记');
          clear.onclick = () => perform(async () => { await ctx.backend.call('clear', {sessionId: record.id}); await update(); });
          row.append(clear); records.append(row);
        }
        if (!state.sessions.length) records.append(node('p', '尚未重置任何会话'));
        paint();
      }
      void update().catch(error => { if (root.isConnected) status.textContent = friendlyError(error); });
      return () => surfaces.delete(surface);
    },
  });
  ctx.registerSlot({slot: 'composer.above', render: ({container}) => {
    const root = node('div'); root.className = 'replay-reset-toolbar';
    const resetButton = node('button', '↻ 重置旧回放'); resetButton.title = '仅标记当前会话的旧回放，保留聊天历史';
    const manage = node('button', '接入管理'); manage.onclick = () => panel.open();
    const status = node('span');
    resetButton.onclick = () => reset(currentId());
    root.append(resetButton, manage, status); container.append(root);
    const surface = {root, reset: resetButton, status}; surfaces.add(surface); paint();
    return () => surfaces.delete(surface);
  }});
  ctx.registerRowAction({label: '重置旧回放', icon: '↻', surfaces: ['sidebar', 'archived'],
    onActivate: async ({session_id, resolve, close}) => {
      const resolved = session_id || await resolve();
      const id = typeof resolved === 'string' ? resolved : resolved?.session_id || resolved?.sessionId || resolved?.id;
      close(); await reset(id);
    },
  });
  ctx.registerComposerAction({label: '旧回放重置与接入管理', icon: '↻', onActivate: () => panel.open()});
  ctx.on('agent/status', ({sessionId, status}) => {
    if (status === 'running') runningSessions.add(sessionId); else runningSessions.delete(sessionId);
    paint();
  });
  ctx.onScan(paint, {phase: 'light'});
  ctx.effect(() => {
    const style = node('style'); style.id = 'codex-plus-ext-replay-reset-style';
    style.textContent = `
      [data-codex-plus-ext="codex-replay-reset"] { box-sizing: border-box; }
      .replay-reset-toolbar { display:flex; align-items:center; gap:10px; padding:6px 8px; font-size:12px; color:var(--codex-plus-text); }
      .replay-reset-toolbar span { opacity:.6; overflow:hidden; white-space:nowrap; text-overflow:ellipsis; }
      .replay-reset-toolbar button,.replay-reset-panel button { cursor:pointer; border:1px solid var(--codex-plus-border); border-radius:6px; padding:5px 9px; color:var(--codex-plus-text); background:var(--codex-plus-bg-elevated); }
      .replay-reset-toolbar button:disabled,.replay-reset-panel button:disabled { opacity:.4; cursor:default; }
      .replay-reset-panel { padding:18px; color:var(--codex-plus-text); font-size:13px; line-height:1.65; }
      .replay-reset-panel h2 { font-size:19px; font-weight:650; margin:0 0 12px; }
      .replay-reset-panel h3 { font-size:14px; margin:22px 0 8px; }
      .replay-reset-panel p { margin:10px 0 15px; white-space:pre-line; overflow-wrap:anywhere; opacity:.8; }
      .replay-reset-actions { display:flex; flex-wrap:wrap; gap:8px; margin:14px 0; }
      .replay-reset-record { display:flex; flex-direction:column; gap:6px; padding:12px 0; border-bottom:1px solid var(--codex-plus-border); }
      .replay-reset-record code { font-size:11px; overflow-wrap:anywhere; }
      .replay-reset-record button { align-self:flex-start; }
    `;
    document.head.append(style);
    void ctx.backend.call('initialize').then(refresh).catch(error => ctx.toast(friendlyError(error), {type: 'error'}));
    return () => { style.remove(); surfaces.clear(); };
  });
  const stop = ctx.setInterval(() => { void refresh().catch(() => {}); }, 15000);
  ctx.effect(() => () => stop());
});
