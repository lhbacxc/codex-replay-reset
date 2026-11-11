# 开发、部署与 GitHub 发布

## 文件组织

GitHub 仓库包含源码、拓展清单、测试、文档和打包脚本。`./dist/`、ZIP、`./.runtime/` 和凭据文件由 Git 忽略。Release ZIP 是给使用者下载的安装附件，源码仓库用于持续开发。

新 Agent 打开本工作区后，从 [AGENTS.md](../AGENTS.md) 与 [AIREADME.md](../AIREADME.md) 开始，按任务读取对应技术文档，无需依赖之前的聊天记录。

## 本地命令

Node.js 20 或以上、PowerShell 7 或以上，使用 Node 内置模块。

```powershell
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$PSDefaultParameterValues['*:Encoding'] = 'UTF8'
npm test
if ($LASTEXITCODE -ne 0) { throw '测试失败' }
npm run check
if ($LASTEXITCODE -ne 0) { throw '语法检查失败' }
npm run package
if ($LASTEXITCODE -ne 0) { throw '打包失败' }
```

测试只使用临时目录、合成会话和本地模拟上游，不修改真实配置。`npm run package` 检查两份清单的版本一致性，再生成 `./dist/codex-replay-reset-版本号.zip`，并检查没有私有运行目录。

## 更新运行副本

工作区代码与 Codex++ 已安装拓展分别存在，修改仓库文件不会自动部署。有拓展工具时按其接口更新用户指定的已安装拓展，再将公开源码同步回仓库；无工具时测试、打包后通过管理器安装。

涉及运行文件覆盖前，先在旧拓展中解除接入并停止代理，保留其 `./.runtime/`，再替换公开文件、热重载并重新接入。启动前钩子变化后，通过 Codex++ 重启 Codex。

原生会话索引缺失时，后备读取本地 JSONL；其安全约束见 [技术说明](./technical.md)。不要为了消除状态查询错误而直接跳过空闲检查。

## 发布

1. 同步 `./package.json` 与 `./codexpp.json` 的版本，更新 `./CHANGELOG.md`。
2. 完成本地测试、语法检查和打包，检查 Git 待提交列表。
3. 推送源码到 GitHub；CI 在 Windows 的 Node.js 20 和 24 上运行同一组检查。
4. 创建对应版本的 Git tag 和 Release，上传 `./dist/` 中的 ZIP。
5. 核对 Release 下载附件与 tag 的源码版本一致，并确认安装说明可直接操作。

GitHub CLI 示例，仓库身份由当前 Git remote 决定：

```powershell
$ErrorActionPreference = 'Stop'
$OutputEncoding = [Console]::InputEncoding = [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
$PSDefaultParameterValues['*:Encoding'] = 'UTF8'
git push origin main
if ($LASTEXITCODE -ne 0) { throw '源码推送失败' }
gh release create v0.1.1 './dist/codex-replay-reset-0.1.1.zip' --title 'v0.1.1 旧回放重置' --notes-file './CHANGELOG.md'
if ($LASTEXITCODE -ne 0) { throw 'Release 发布失败' }
```

示例版本只适用于本次发布，后续版本需同步替换。Release 不上传真实连接状态、API Key、会话内容或个人调试文件。
