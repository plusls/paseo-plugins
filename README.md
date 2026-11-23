# paseo-plugins

Paseo 插件集合，使用 pnpm workspace 管理。每个插件仍然独立安装，可以只装其中一个。

## 插件

| 目录 | 说明 |
| --- | --- |
| [aio-quota](plugins/aio-quota/README.md) | 在侧边栏显示 AIO Coding Hub 的 Codex 额度 |
| [context-headroom](plugins/context-headroom/README.md) | 在 composer 显示当前 agent 的上下文余量 |

## 安装

要求 Paseo 0.17.1 或更高版本。以下命令以仓库已推送到 GitHub 为前提。从 monorepo 子目录安装：

```bash
paseo plugin install github:plusls/paseo-plugins:plugins/aio-quota
paseo plugin install github:plusls/paseo-plugins:plugins/context-headroom
```

把 `plusls/paseo-plugins` 换成实际的 GitHub owner 和仓库名。Git 安装会克隆整个仓库，再使用 `:plugins/<name>` 指定的插件子目录。私有仓库需要 daemon 所在机器能访问该仓库。

本地开发时从目录安装，在仓库根目录执行：

```bash
paseo plugin install "$PWD/plugins/aio-quota"
paseo plugin install "$PWD/plugins/context-headroom"
```

同一 daemon 已安装同 ID 插件时先执行 `paseo plugin remove <id>`。移除目录插件只删除配置，不删除源码目录。

## 开发

在仓库根目录安装全部插件的开发依赖：

```bash
pnpm install
pnpm run lint
pnpm run typecheck
```

打包单个插件：

```bash
pnpm --filter aio-quota pack --pack-destination "$PWD/dist"
pnpm --filter context-headroom pack --pack-destination "$PWD/dist"
```

产物在 `dist/<插件名>-<version>.tgz`。插件没有运行时依赖，Paseo 直接编译 TypeScript，不需要额外的构建步骤。

## Git hook

仓库提供 `.githooks/pre-commit`，提交前运行全部插件的 lint 和 typecheck。克隆后执行一次：

```bash
pnpm run hooks:install
```

该命令把本地 `core.hooksPath` 指向 `.githooks`。hook 配置不会随仓库同步，每个克隆都需要执行一次。

## CI

`.github/workflows/ci.yml` 在 push 和 pull request 时运行 lint、typecheck，并为每个插件生成 tgz 包。打包产物作为 workflow artifact 上传，保留 30 天。CI 不创建 release，也不发布到 npm。

## 目录结构

```text
paseo-plugins/
  plugins/
    aio-quota/
    context-headroom/
```

每个插件目录包含自己的 `paseo-plugin.json`、`package.json`、TypeScript 入口和 README；根目录只放 workspace、CI 和公共开发配置。
