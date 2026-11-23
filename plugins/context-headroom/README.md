# context-headroom

Paseo 插件：在 composer 显示当前 agent 的上下文余量。数值口径对齐 plusls 的 `~/.claude/statusline-command.sh`，v1 只精确支持 Claude Code provider。

## 显示

- composer pill 标题为「上下文余量」，label 形如 `70% · 72k`
- 点击 pill 打开 popover，显示已用 / 压缩阈值、已用百分比、剩余 token、进度条、窗口长度、阈值来源、provider 和更新时间
- 已用超过压缩阈值时 label 显示 `超过 12k`，popover 显示「已超过压缩阈值」，差额保留为负数
- 没有 usage 的 agent 不显示 pill
- 非 Claude provider 只显示 Paseo 原始窗口的 used / max 和剩余，并在 popover 标注「压缩阈值未知」

## 数据口径

Claude provider 的 used 优先从 Claude Code transcript 读取：

```text
used      = 最后一条主链 assistant 的 input_tokens + cache_creation_input_tokens + cache_read_input_tokens
auto      = env.CLAUDE_CODE_AUTO_COMPACT_WINDOW，未设置时用 contextWindowMaxTokens
pct       = env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE，未设置时用 95
threshold = floor(min(auto, contextWindowMaxTokens) * pct / 100)
remaining = threshold - used
usedPct   = used * 100 / threshold
```

这样与 statusline 的 `total_input_tokens` 同源。插件会用 transcript 的 input + cache + output 与 Paseo 的 `contextWindowUsedTokens` 做一致性校验，只有相等时才采用。

transcript 还没写入当前消息或不可用时，Paseo 的 `outputTokens` 是结果消息里的累计值，无法可靠扣成 input-only。此时直接用 `contextWindowUsedTokens` 原始值，并在 popover 标注「已用 token 包含输出」。宁可少报余量，也不静默低估已用。

transcript 位于 `~/.claude/projects/<project>/<sessionId>.jsonl`。插件只解析 usage 数字，不读取、不记录消息正文。

阈值设置按 user -> project -> local 顺序读取：

- `~/.claude/settings.json`
- `<agent.cwd>/.claude/settings.json`
- `<agent.cwd>/.claude/settings.local.json`

只读取 `env.CLAUDE_CODE_AUTO_COMPACT_WINDOW` 和 `env.CLAUDE_AUTOCOMPACT_PCT_OVERRIDE` 两个键。文件不存在视为未设置；JSON 损坏或值非法时 popover 显示错误，不伪造阈值。插件不读取 daemon 的 `process.env`。

数值通过插件 subscription 和 Paseo agent subscribe 推送，不做轮询。

## 安装

从 GitHub 的 monorepo 子目录安装：

```bash
paseo plugin install github:plusls/paseo-plugins:plugins/context-headroom
```

本地开发时在仓库根目录执行：

```bash
paseo plugin install "$PWD/plugins/context-headroom"
```

从 tgz 安装：

```bash
pnpm --filter context-headroom pack --pack-destination "$PWD/dist"
tar -xzf dist/context-headroom-<version>.tgz
paseo plugin install "/绝对路径/package"
```

同一 daemon 已安装同 ID 插件时先执行 `paseo plugin remove context-headroom`。移除目录插件只删除配置，不删除源码目录。

## 打包

插件没有运行时依赖，Paseo 直接编译 TypeScript，不需要额外构建步骤。在仓库根目录执行：

```bash
pnpm install
pnpm --filter context-headroom run lint
pnpm --filter context-headroom run typecheck
pnpm --filter context-headroom pack --pack-destination "$PWD/dist"
```

产物是 `dist/context-headroom-<version>.tgz`。包内容由 `package.json` 的 `files` 白名单决定；`package.json` 保留 `private: true`，不发布到 npm。

## 开发

本地开发时从目录安装，改动后执行：

```bash
paseo plugin reload context-headroom
```

查看插件侧输出：

```bash
paseo plugin logs context-headroom
```

## 限制

- 只对 Claude Code provider 计算压缩阈值；Codex、DSH 等其他 provider 的阈值逻辑未知，插件不猜
- 不读 Paseo 的 `--settings` 内联 JSON
- 不监听 settings 文件变化；文件修改后在下一次 agent 更新时生效
- transcript 位于 `~/.claude/projects`；使用其他 `CLAUDE_CONFIG_DIR` 的 agent 读不到 transcript，退回 Paseo usage 口径
