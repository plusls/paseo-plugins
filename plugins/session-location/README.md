# session-location

Paseo 插件：在 composer 显示当前 agent 会话实际所在的目录。cwd 从 Claude Code 的会话记录读取，会话里 `cd` 到 worktree 后也会更新；读不到时回退到 agent 快照。

## 显示

- composer pill 显示缩短后的会话路径：worktree 内显示 worktree 名，如 `permis…audit`；workspace 根显示 `./`，子目录显示 `./client`，workspace 外显示 `~/…/devtron`
- 鼠标悬停 tooltip 显示完整 cwd
- 点击 pill 打开 popover，显示完整 cwd、来源、workspace 标题、host、agent 标题和更新时间
- 会话记录追加时 pill 跟着更新
- pill 宽度受 Paseo 的 160px 上限约束，完整路径可看 popover 或悬停 tooltip

路径截断规则见 [OVERVIEW.md](OVERVIEW.md#路径显示)。

## 安装

要求 Paseo 0.17.1 或更高版本。从 GitHub 的 monorepo 子目录安装：

```bash
paseo plugin install github:plusls/paseo-plugins:plugins/session-location
```

本地开发时在仓库根目录执行：

```bash
paseo plugin install "$PWD/plugins/session-location"
```

同一 daemon 已安装同 ID 插件时先执行 `paseo plugin remove session-location`。移除目录插件只删除配置，不删除源码目录。

## 开发

在仓库根目录执行：

```bash
pnpm install
pnpm run lint
pnpm run typecheck
pnpm --filter session-location pack --pack-destination "$PWD/dist"
```

本地开发时从目录安装，改动后执行：

```bash
paseo plugin reload session-location
```

查看插件侧输出：

```bash
paseo plugin logs session-location
```

## 限制

- 目前只解析 Claude Code 的会话记录；其他 provider 回退到 agent 快照，popover 的「来源」会标出
- 只读取会话记录尾部并在内存中解析单行 JSON，只提取顶层 `cwd`，不记录消息正文或其他字段
- 只显示会话位置，不显示模型、上下文余量等 statusline 其他信息
- home 缩写是路径前缀启发式，不查询真实 home
- workspace 标题只读取一次，改名后需要 reload 插件
- Windows 和 Android 使用同一份 React Native UI，compact 布局按 `layout.compact` 适配
