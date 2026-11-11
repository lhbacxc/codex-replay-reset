# Codex 旧回放重置

为 **Codex++ + CC Switch 路由 + AgentRouter Responses** 提供手动旧回放重置，保留本地聊天历史，尝试恢复上游资源切换后的原会话续聊。

典型错误：

```text
CC Switch local proxy failed while handling Codex endpoint /responses. Provider: Agent Router; model: gpt-6.1-sol; upstream_status: HTTP 400; cause: OpenAI Responses bad request: The requested item was created under a different *** OpenAI resource. Use the same resource that created the item to access it. [hub-] [trace_id=b900c08ad8fbb7c936a64dff8ea650f6]
```

本项目基于 [PopCorey/dsh-replay-reset](https://github.com/PopCorey/dsh-replay-reset) 的使用目标移植，运行逻辑针对 Codex++ 与 Codex Responses 重写。感谢原项目提供设计参考；来源和 MIT 许可见 [NOTICE](./NOTICE.md) 与 [LICENSE](./LICENSE)。

## 简单原理

续聊时，Codex 会把历史消息及推理回放一并发送给上游。如果 AgentRouter 切换了上游资源，旧回放仍可能带有原资源生成的推理数据和条目 ID；新资源无法使用这些旧条目，于是返回上述 HTTP 400 错误。

点击“重置旧回放”后，拓展标记当前会话，在下一条完整请求中捕获旧回放的指纹，并清理匹配的旧推理回放和历史资源 ID，让当前资源根据保留的历史重新建立上下文。清理只发生在发出的请求副本中，本地聊天记录、可见文字、工具调用参数和结果，以及工具配对用的 `call_id` 都保留；后续新生成的回放也正常保留。

## 下载安装

1. 安装并运行 Codex++，在 CC Switch 中开启 Codex 路由。
2. 从 [Releases](https://github.com/lhbacxc/codex-replay-reset/releases) 下载 `codex-replay-reset-版本号.zip`。
3. 解压到名为 `codex-replay-reset` 的目录，再放入 **Codex++ 管理器显示的本地拓展目录**。文件结构应为 `./codex-replay-reset/codexpp.json`，不要多套一层目录。
4. 在 Codex++“本地拓展”中启用“旧回放重置”，点击“热重载”。

需要支持 Node.js 20 或以上的拓展后台运行环境。新安装时运行状态为空，每位用户分别在自己的电脑接入代理。

## 使用

1. 在 Codex 输入框上方点“接入管理”，再点“接入清理代理”。
2. 首次接入后，**通过 Codex++ 重启 Codex，再恢复发生报错的原会话**。
3. 等待该会话当前轮次和工具执行结束，点击“重置旧回放”。
4. 提示“已标记”后，在原会话发送下一条正常消息，捕获并清理旧回放。接入面板中可以查看捕获数量和清理次数。

侧栏会话行的“更多操作”里也有“重置旧回放”。点击只标记策略，不发送消息或重跑工具。已捕获的旧条目持续被识别，之后生成的新回放正常保留。

```text
Codex → 本地回放清理代理 → CC Switch 路由 → AgentRouter
```

清理代理默认监听本机端口 `18761`，上游保持为接入时的 CC Switch 本地地址。接入只替换当前供应商配置中的 `base_url`；模型、鉴权字段、CC Switch 数据库和聊天文件保持原状。

如果 CC Switch 将同一供应商写回原路由地址，代理每 5 秒检查并维持接入；供应商或路由地址变化时停止自动维持，需要重新接入。代理跨页面刷新保留，通过 Codex++ 启动 Codex 时会恢复已接入状态；关闭一个窗口不会停止共享代理。

## 解除、升级与移除

在“接入管理”中点击“解除接入”，然后重启 Codex，使会话使用恢复后的 CC Switch 地址。已经打开的会话仍可能使用旧清理地址，因此解除后保留透传进程；结束这些会话后可以点击“停止清理代理”。

升级、停用、删除或迁移拓展前，先解除接入并停止代理。升级时保留原拓展的 `./.runtime/` 私有状态；Release 压缩包不包含其他用户的运行状态。

“撤销此会话标记”只删除该会话的清理策略，原历史一直保留。撤销后，旧资源绑定错误可能再次出现。

## 适用范围

- 运行在 Codex++ 的页面拓展中，面向 Windows 与 CC Switch 本地 `/v1` Responses HTTP 路由。
- 仅处理所选会话，子代理和独立分叉分别操作。
- 清理匹配的旧 reasoning 条目和历史资源 `id`，保留可见文字、工具参数与结果，以及 `call_id` 配对。
- 上游会话引用、无法展开的条目引用、加密压缩上下文、不完整工具配对等情况会拒绝清理，避免丢失上下文。
- WebSocket 握手返回 HTTP 426，依赖 Codex 的 HTTP 回退能力；请求体上限为 128 MiB，重置暂不支持压缩请求体。
- 余额不足、密钥无效、模型不存在和网络故障不属于重置范围。

实际使用已确认功能成功；其他上游和不同协议形态仍需分别验证。完整实现与验证范围见 [技术说明](./docs/technical.md)，版本变化见 [更新记录](./CHANGELOG.md)。

## 源码与后续开发

GitHub 仓库存放源码、测试和文档，Release ZIP 是安装附件。开发入口见 [AIREADME.md](./AIREADME.md)，Agent 执行约束见 [AGENTS.md](./AGENTS.md)。

```powershell
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$PSDefaultParameterValues['*:Encoding'] = 'UTF8'
npm test
npm run check
npm run package
```

项目使用 Node.js 内置模块。测试仅使用合成会话和本地模拟上游；打包生成 `./dist/codex-replay-reset-版本号.zip`。发布步骤见 [发布与开发说明](./docs/development.md)。
