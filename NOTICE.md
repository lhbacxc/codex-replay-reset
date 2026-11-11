# 来源与许可

本拓展基于 PopCorey/dsh-replay-reset 的使用目标和“保留历史、按旧回放指纹处理请求”的设计进行 Codex 移植。原项目网址：https://github.com/PopCorey/dsh-replay-reset ，所参考版本为 main 分支的 0.1.3。

运行代码针对 Codex++ 拓展 API 与 Codex Responses HTTP 数据重新实现，不分发 DSH 程序、DeepSeek SDK、用户配置或真实会话数据。MIT 许可及来源版权保留在 ./LICENSE。

Codex 请求头的兼容性依据公开实现：https://github.com/openai/codex/blob/main/codex-rs/codex-api/src/requests/headers.rs 。该源码仅用于核对协议，没有复制其 Rust 实现到本拓展。
