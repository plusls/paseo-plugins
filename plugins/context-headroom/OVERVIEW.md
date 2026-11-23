# context-headroom

在 Paseo composer 里显示当前 agent 的上下文余量，数值口径与 Claude Code statusline 一致。

## 做什么

- 每个有 usage 的 agent 在 composer 显示一个 pill，label 形如 `70% · 72k`
- popover 显示已用 / 压缩阈值、已用百分比、剩余 token、进度条、窗口长度、阈值来源、provider 和更新时间
- 超过压缩阈值时显示负的剩余差额，并明确提示「已超过压缩阈值」
- 没有 usage 的 agent 不显示 pill

## 工作方式

Paseo 的 agent usage 通过订阅推送，插件在 daemon 端计算快照：

- Claude provider 从最后一条主链 assistant transcript 的 input-only usage 得到 used，与 statusline 的 `total_input_tokens` 同源
- transcript 不存在或还没写入当前消息时，直接用 `contextWindowUsedTokens` 原始值，并标注包含输出；宁可少报余量，也不静默低估已用
- 压缩阈值按 `floor(min(auto, contextWindowMaxTokens) * pct / 100)` 计算，`auto` 和 `pct` 来自 Claude settings，缺省时分别用 context window 和 95
- 其他 provider 只展示 Paseo 原始窗口的 used / max，压缩阈值标注为未知

## 使用前提

- Paseo 0.17.1 或更高版本
- 使用 Claude Code provider 时，压缩阈值设置可以放在 `~/.claude/settings.json`、项目 `.claude/settings.json` 或 `.claude/settings.local.json` 的 `env` 中

## 读取的数据和限制

插件只读取上述 settings 文件中的 `CLAUDE_CODE_AUTO_COMPACT_WINDOW` 和 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`，以及 Claude transcript 里的 usage 数字；不读取消息正文，不上传数据。

- settings 文件损坏或值非法时，popover 显示具体错误，不退回一个猜测的阈值
- 只对 Claude Code provider 计算压缩阈值，Codex、DSH 等其他 provider 不猜
- 不监听 settings 文件变化，修改后在下一次 agent 更新时生效
- transcript 读不到时退回 Paseo usage；退回原始值时 popover 会标注已用 token 包含输出
