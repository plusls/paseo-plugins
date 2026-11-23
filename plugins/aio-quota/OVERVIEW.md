# aio-quota

在 Paseo 侧边栏显示 AIO Coding Hub 的 Codex 额度。

## 做什么

- 侧边栏 footer 有一个 Codex 条目，显示剩余百分比和细条
- 点击条目打开明细，显示套餐、各窗口的已用和剩余百分比、窗口长度、重置时间、更新时间和刷新按钮
- 剩余不足阈值时使用警告色或危险色；额度已达上限时按危险色显示
- 请求失败显示「额度不可用」，错误详情在明细中

## 工作方式

插件在 Paseo daemon 上请求配置的 AIO Coding Hub usage 接口，只保留套餐和额度窗口字段。客户端定期请求，daemon 短时缓存快照供多个客户端共用。点击条目或明细里的刷新按钮会绕过缓存。

## 使用前提

- Paseo 0.17.1 或更高版本
- daemon 所在机器能访问 AIO Coding Hub 的 usage 接口
- 插件位于 pnpm monorepo 的 `plugins/aio-quota`，从仓库子目录安装

## 配置

在 Settings → Plugins → aio-quota 的设置里修改 `Usage 接口地址`，默认是 `http://127.0.0.1:37123/v1/usage`，只接受 http 和 https 地址。设置按 host 保存，由 daemon 发起请求。

## 读取的数据和限制

插件只读取 `plan_type`、`rate_limit.limit_reached` 和两个额度窗口里的已用百分比、窗口长度、重置字段。响应中的 `email`、`account_id`、`user_id` 等账号标识在解析时丢弃，不显示、不记录、不缓存。

- 不使用 AIO 的 SQLite，也不读取其他来源的余额或接入其他 provider
- 接口没有额度窗口时显示「无可用额度窗口」
- 默认使用 daemon 本机地址；AIO Coding Hub 在另一台机器时，需要把地址改成 daemon 能访问的 URL
