# 技术说明

## 目录与数据流

| 文件 | 职责 |
| --- | --- |
| `./renderer.js` | 输入区操作、会话行操作、接入管理侧面板 |
| `./backend/main.mjs` | 页面与本地控制器之间的桥接；查询目标会话空闲状态 |
| `./core/controller.mjs` | 最小修改供应商 base_url、恢复连接、启动和控制代理 |
| `./core/session-state.mjs` | 宿主索引缺失时只读检查原生 JSONL 的身份、结束状态和工具配对 |
| `./core/policy.mjs` | 捕获与匹配旧条目指纹、配对检查、请求副本投影 |
| `./bridge/server.mjs` | 本地 HTTP/SSE 代理、控制鉴权、活动请求计数 |
| `./launch/before.mjs` | Codex++ 启动前恢复已接入代理 |
| `./test/` | 合成数据与本地模拟服务验证 |
| `./.runtime/` | 私有连接状态和重置策略，不分发 |

页面通过拓展后台控制代理，不直接读取聊天文件或凭据。模型请求转发保留原鉴权头，控制凭证不转发给 CC Switch。

## 标记与投影

重置时保存目标会话 ID 和 operation ID，进入等待捕获状态。目标会话下一条完整 HTTP Responses 请求到来时，核对引用、加密压缩和工具配对；随后捕获旧 reasoning 条目及可内联历史条目的 SHA-256 指纹。

请求副本删除匹配的旧 reasoning，去除匹配条目的资源 id。工具调用的 call_id、参数、结果与可见文字保留。原请求对象、本地历史和新回放不被修改。

已捕获策略持久保存，不是每轮清空推理。再次点击会生成新 operation ID，扩展捕获范围；同一当前 operation ID 幂等。策略不保存聊天正文、推理密文或 API Key。

## 会话识别与维护

Codex 当前公开源码的 Responses 请求头包含 thread-id 和 session-id。前者优先用于真实会话身份，后者可能用于缓存亲和性；仅在缺少前者时兼容旧客户端的会话头。无法识别会话且存在等待捕获的策略时拒绝重置请求。

界面当前会话从实际核对过的 data-response-annotation-conversation 属性读取，多个身份或不存在时不猜测。会话行操作使用宿主提供的会话身份。

运行中的原生主按钮、agent/status 事件、后台会话事件，以及代理活动请求计数用于阻止运行态重置。

宿主会话索引可能未包含可 resume 的原生会话。索引明确返回“没有找到会话”、空事件列表或查询服务不可用时，后备扫描 Codex 数据目录中的 ./sessions/ 与 ./archived_sessions/，按 UUID 找到唯一 JSONL 文件，核对 session_meta 身份、task_started/task_complete/turn_aborted 和工具配对。读取前后检查文件状态；记录变化、身份不一致、未结束、格式损坏或未知查询错误时拒绝重置。只读取，不修改原始记录。取消流式请求会销毁上游请求并释放活动计数。

## 配置与生命周期

配置定位仅支持清晰的当前 model_provider 及对应供应商 Responses 配置表；不引入 TOML 依赖。base_url 单处替换保留其余文本、中文编码与换行。写入前再次检查文件内容，发现并发修改则拒绝覆盖。

原 URL、供应商身份和清理 URL 单独保存，不备份完整配置。解除仅恢复仍由本拓展接管的当前连接，避免覆盖供应商切换后的配置。CC Switch 写回原路由时维持接入，其他地址或供应商变化时暂停维持。

私有代理进程跨页面刷新保留；显式停止会先解除接入。启动前钩子只恢复已接入状态，不会重新接入已解除的代理。无退出钩子，避免关闭一个窗口影响其他已打开的窗口。

## 验证记录

0.1.1 已在 Node.js 24.14.1 通过 27 项测试，覆盖：

- 未标记请求、其他会话、原对象不变。
- 旧回放清理、可见文字和工具结果保留、新回放保留。
- JSON 重载指纹、幂等 operation、损坏策略拒绝加载。
- 引用和压缩历史、缺失工具配对拒绝清理。
- UTF-8/CRLF 最小配置替换与恢复。
- HTTP 状态、SSE、请求路径、合成鉴权头透传。
- 控制鉴权、跨源拒绝、活动请求保护、取消传播。
- 实际独立 Node 后台启动、CC Switch 重写维护、解除和停止。
- 界面注册、插槽构建、运行态按钮和卸载清理的离线检查。
- 宿主索引缺失与空索引、归档记录、原生运行态、身份不一致、未知终止状态、损坏 JSON 行的后备检查。

本机接入已确认：当前供应商 base_url 仅修改一行，指向已启动的清理代理；上游仍为原 CC Switch 路由。未修改模型、鉴权字段或 CC Switch 数据库。

实际使用已确认功能成功；自动测试仍使用合成会话与本地模拟上游，没有在测试中发送真实模型请求。已确认输入区操作入口显示。既有旧脚本不支持页内热重载时，安装工具不会自动刷新 Codex，需要用户手动热重载界面脚本。

## 来源

- [原项目及 MIT 许可](https://github.com/PopCorey/dsh-replay-reset)
- [Codex 会话请求头实现](https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/requests/headers.rs)
- [OpenAI Responses 推理回放说明](https://developers.openai.com/api/docs/guides/reasoning)
