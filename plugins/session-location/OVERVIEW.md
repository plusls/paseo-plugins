# session-location

在 Paseo composer 里显示当前 agent 会话实际所在的目录。cwd 从 provider 的会话记录里读，而不是用 agent 快照：Paseo 的 agent 快照 cwd 停在创建/导入时，不跟会话里的 `cd` 变化，workspace 记录也仍然指向主 checkout。

## 做什么

- 每个 agent 在 composer 显示一个 pill，label 是缩短后的会话路径
- 点击 pill 打开 popover，显示完整 cwd、来源、workspace 标题、host、agent 标题和更新时间
- 会话记录追加时 pill 跟着更新

## 路径显示

Paseo 给 composer pill 的 `maxWidth` 是 160px（`packages/app/src/plugins/buttons/view.tsx`），扣掉图标、chevron、间距和内边距后正文只剩一小段。超过这个宽度 Paseo 会从尾部直接截断，所以插件先用更小的预算自己截断：ASCII 记 1 个宽度单位，中文等全角字符记 2 个，预算见 `client/location.tsx` 的 `PILL_TEXT_UNITS`。

pill 上的路径按以下顺序处理：

1. cwd 在 workspace 目录内时，前缀折叠成 `./`，只显示相对路径；cwd 就是 workspace 根时显示 `./`
2. cwd 在 workspace 内但进入了其下的 worktree（例如 `.local/worktrees/<name>`）时，显示 worktree 名
3. workspace 外的 cwd 在 worktree 内时也显示 worktree 名，支持 Paseo 的 `worktrees/<hash>/<slug>` 和单层 `worktrees/<name>` 布局
4. 相对路径不超预算时完整显示，例如 `./client`
5. 相对路径超长时保留 `./…/` 和目录名首尾，例如 `./…/ses…ion`
6. workspace 外的路径做 home 缩写：`/home/<user>`、`/Users/<user>`、`C:\Users\<user>` 替换为 `~`
7. 缩写后不超过预算时显示完整路径，例如 `~/my`
8. 超过时锚定 home（非 home 路径用第一个路径段），省略中间，保留目录名首尾，例如 `~/…/devtron`、`/opt/…/pr…e`

Windows 路径使用反斜杠，相对路径前缀显示为 `.\`。

tooltip 显示完整 cwd，popover 里显示完整 cwd、来源、workspace 标题、host、agent 标题和更新时间。

## 工作方式

- daemon 端找到 agent 对应的 Claude Code 会话记录：`~/.claude/projects/<encoded-cwd>/<sessionId>.jsonl`，根目录可用 `CLAUDE_CONFIG_DIR` 覆盖
- 从文件尾部向前读取主链记录的顶层 `cwd`，跳过 `isSidechain: true` 的子代理记录；读取上限见 `server/transcript.ts` 的 `MAX_TAIL_BYTES`，按文件大小缓存结果
- 用 `fs.watch` 监听会话记录追加，去抖后重新读取并推送（见 `server/location.ts` 的 `schedulePublish`）；会话记录还没生成时，在后续 agent 更新里重试
- rewind 等在同一个 agent 上换出新的 session 时，按新的 `sessionId` 重新查找并切换 watcher
- 读不到会话记录（非 Claude provider、文件未生成、解析失败）时回退到 agent 快照 cwd，popover 的「来源」显示 `agent 快照`
- workspace 标题在订阅建立后第一次需要时读取一次，供 popover 展示
- client 端为每个 agent 注册 composer pill 和插件订阅

## 限制

- 目前只解析 Claude Code 的会话记录；其他 provider 回退到 agent 快照
- transcript 根目录取 daemon 进程的 `CLAUDE_CONFIG_DIR` 或 `~/.claude`；provider profile 单独覆盖 `CLAUDE_CONFIG_DIR` 时读不到，回退到 agent 快照
- 只提取会话记录尾部的顶层 `cwd`，不记录消息正文或其他字段
- home 缩写是路径前缀的启发式判断，不查询真实的用户 home
- workspace 标题只读取一次，改名后需要 reload 插件才更新
- pill 文案受 Paseo composer pill 的 160px 宽度上限约束，长路径只能显示首尾；完整路径看 popover 或 tooltip
- 只显示会话位置，不显示模型、上下文余量、时间等 statusline 其他信息
