# human-tokens 设计说明

显示名 huken，插件 ID 仍是 `human-tokens`。

统计「AI 时代人类实际付出了多少」：读了多少 AI 输出、自己打了多少字、回看了多少、切换了多少次上下文。插件只在自己的界面里展示数据，不改时间线，不改 composer。

## 做什么

- 读取当前视口里已完成的 assistant 消息，按可见比例和停留时间估算首次阅读覆盖
- 已完成的已读内容离开 `REVIEW_GAP_MS` 以上再出现时，单独累计回看覆盖和重读次数
- 采样 composer prompt 的正向增量，扣除 web 的真实 paste 事件，统计人类输入
- 取可见面积最大的 agent 作为当前上下文，agent 变化时记一次切换
- 客户端按批上传覆盖和事件增量，daemon 按天和 5 分钟桶写入 SQLite，页面和侧边栏读取汇总

## 不做什么

- 不接 tokenizer。所有 huk/tok 数字只适合比较趋势，不是模型的 billing token
- 不检测 AFK、眼球运动或系统空闲。人离开但窗口还在前台时，停留时间仍会累计
- 不补算历史消息。只有插件运行期间真正挂载并进入视口的消息才会被记录
- 不区分「看完一遍」和「扫一眼记住」。完成判定基于按字数估算的阅读时长
- 不统计 cache hit。命中不可观测，只统计重读造成的 cache miss
- 不读消息正文入库，也不把正文写日志。正文只在客户端内存里用于计算覆盖

## 指标定义

### huken、token 和 chars

`chars` 是消息正文的 Unicode 码点数，代理对算一个码点。界面里人类侧的读入和输入量用 `huken` 表示，缩写 `huk`；AI 产出沿用 `token` 的表述。三者在本插件里都按字符数计，1 huk = 1 个字符。

每个 bin 的字符数按 `chars / BIN_COUNT` 均分，`BIN_COUNT` 段加起来等于 `chars`，不要求整除。

### estimateMs 和 dwellMs

一条消息的总阅读时长按 ASCII 和非 ASCII 字符分别估算，取一个最短时长兜底。总时长再均分给 `BIN_COUNT` 个 bin，得到每个 bin 的 `estimateMs`。

`dwellMs` 是某个 bin 在可见且前台时累计到的时间，封顶 `estimateMs`。每次采样只有一个 `dt`，按 `visibleFraction * estimateMs` 的权重分给所有活跃 bin，不是每个 bin 各拿一个完整 `dt`。`BIN_COUNT` 个 bin 同时可见时总阅读时间仍然只等于墙钟时间。

`completed` 表示 `dwellMs >= estimateMs`。完成是单调的，不会退回。

### coverage

每个 bin 的首次阅读覆盖，取值 0-255。`255` 表示已完成，未完成最多上报 `254`，避免四舍五入把「快读完」写成「已读完」。`readTokens` 按覆盖比例折算，`completedTokens` 只统计 `255` 的 bin。

### reviewCoverage 和 missTokens

回看覆盖单独存储，不修改首次阅读覆盖。bin 完成、从不可见变为可见、且距离上次隐藏至少 `REVIEW_GAP_MS` 时，进入一个回看片段。片段内的停留按同一个估算时长折算成 0-255 的回看覆盖。

客户端内部字段对应关系：`reviewActive` 表示 bin 当前是否处在回看片段，`reviewDwellMs` 是本片段累计停留（片段开始时清零），`reviewCoverage` 是历史最大回看覆盖。只有 `reviewCoverage` 会上传。

`missTokens` 就是回看覆盖折算出的读入量，界面用 `huk` 表示。用户重读说明人类这边的 cache 没有命中；已经命中、无需重读的部分不可观测，所以界面只报 cache miss 比例：

```text
cache miss = missTokens / completedTokens
```

同一个 bin 的回看覆盖取历史最大值，所以反复回看不会把 miss 量重复累加；次数由 `revisits` 单独统计。

### revisits

回看片段的停留达到该 bin 估算时长的 `REVIEW_RATIO`（并有一个最短时长下限）后，给这条消息记一次重读事件。一条消息在一个回看片段里最多计一次；离开回看活动超过 `REVIEW_GAP_MS` 后再回来，才算新片段。

跨 session 的回看由 daemon 推断：新 session 读到其他 session 已经完成（`255`）的 bin，且本次覆盖达到 `REVIEW_INFER_COVERAGE` 时，把本次覆盖折成回看覆盖。每个 message/session 最多推断一次 `revisits`，避免长内容跨多个批次重复计数。

### typedChars 和 activeTypingMs

客户端每 `SAMPLE_MS` 采样一次当前 composer 的 prompt 码点数：

- 正向增量先扣掉 web `paste` 事件记下的长度
- 扣除后仍达到 `PASTE_THRESHOLD` 的增量按粘贴或草稿恢复处理，不计输入
- 剩余正增量计入 `typedChars`
- 每个出现正增量的采样计一个 `SAMPLE_MS` 的 `activeTypingMs`
- 增量为 0 或负数时只重置基线，不产生负数，同时清空还没用掉的粘贴额度，避免等长替换粘贴扣掉后面的真实输入

native 没有 paste 事件，短粘贴（低于阈值）会被当成输入。这是已知误差。

### activeReadMs、activeReviewMs

采样时按首次阅读和回看两个权重把 `dt` 分给活跃 bin，分别累加到 `activeReadMs` 和 `activeReviewMs`。这两个值只表示「有阅读/回看注意力」的时间，不检测人是否真的在看。读速是 `readTokens / activeReadMs`，回看速度是 `missTokens / activeReviewMs`。`missTokens` 包含 daemon 跨 session 推断的回看，但推断部分没有对应的 `activeReviewMs`，跨会话回读较多时回看速度会偏高，低样本量下波动也会很大，只适合看趋势。

### slot 和 5 分钟归属

`slot_stats` 按 `(day, slot, device_id)` 累计 `read_tokens`、`miss_tokens`、`typed_chars`、`active_read_ms`、`active_review_ms` 和 `active_typing_ms`。`slot` 是客户端构建上传批次时的本地 5 分钟桶，`SLOTS_PER_DAY = 288`，同一批增量整批记到这个桶；正常上传时误差最多一个 `FLUSH_MS` 左右。

查询只返回 `input.today` 当天的 288 个桶，没有活动的 slot 补 0。页面先对每个序列做过去 15 分钟的滑动平均：已完成的桶取它自己和之前两个桶，当前桶按已经过去的时间比例加权，窗口最左端的桶按剩余比例加权，不使用还没发生的部分；当前桶之后的桶固定为 0，曲线、纵轴和选点都不越过当前桶。再按 5 分钟逐点绘制读入和输入两张图，0 值段跳过，基线单独画。视口默认取最后一个活动桶附近 3 小时（36 个桶），可在 1-24 小时之间缩放；只绘制可见范围内的线段，纵轴按可见范围内的最大值缩放。桌面可用滚轮缩放，移动端和桌面都有缩小/放大按钮；滚轮按光标位置锚定，按钮按当前选中点锚定。选择点按横坐标映射到最近的 5 分钟桶，鼠标移动或点击都能选中，键盘聚焦到图上后左右方向键切换；明细显示同一个平滑值，不显示原始桶值。

5 分钟桶只服务当天曲线，保留 90 天，更早的行在 daemon 启动时删除；日汇总仍由 `day_stats` 长期保存。这个粒度从本版本开始采集，升级前的历史没有。上传失败或长时间离线时，失败重试的那批保留构建时的桶，其余积压的增量按恢复后构建的批次归属，可能集中记到少数几个桶。

### switches

取可见高度最大的 agent 作为当前上下文。agent 变化时记一次切换；短暂滚到没有消息的空白不重置上一个 agent，这样 A -> 空白 -> B 仍会记一次 A 到 B 的切换。分屏时面积大的 agent 算当前上下文。

### producedTokens、messages

`producedTokens` 是插件实际见过的已完成 assistant 消息的码点总数，不是 agent 的完整输出历史。`messages` 按 `(messageId, version)` 去重；`version` 是文本长度加两个滚动 hash，同一 `messageId` 的文本变化不会被合并进旧覆盖。

消息身份用 Paseo 的 `occurrenceKey`（`agentId:itemId`），不是单独的 `itemId`。`itemId` 只在 agent 内唯一，跨 agent 可能重复；用完整 `occurrenceKey` 才能避免把两个 agent 的同号消息合并。

## 采集模型

### 采样循环

`client/sampler.ts` 每 `SAMPLE_MS` 跑一次：

1. 检查前台。web 要求 `document.visibilityState === "visible"` 且 `document.hasFocus()`；native 视为始终前台
2. 平台层扫描当前可见的已完成 assistant 消息，返回文本、身份和窗口坐标
3. 每条消息按渲染高度切 `BIN_COUNT` 个 bin，计算每个 bin 与时间线视口的重叠比例
4. 更新每个 bin 的可见性和回看片段
5. 把所有可见且需要注意力的 bin 收集起来，共享同一个 `dt` 按权重分配；只露出一部分的 bin 按历史最大可见比例封顶，没完整露出过不会标记读完
6. 记录活跃阅读/回看时间和当前 agent
7. 每 `FLUSH_MS` 或停止插件时上传一批增量

采样宿主挂在侧边栏 footer item 上。即使宿主重复挂载，采样器也是插件级单例，不会重复计时。隐藏的 1x1 View 只用于 native 拿 fiber 根。

### 可见性

- 只有 `phase === "complete"` 的 assistant 消息参与；流式消息不估算
- bin 的可见比例取它与视口重叠高度除以 bin 高度，最大为 1；上下边缘只露出一部分的 bin 按比例放慢累计
- bin 要在相邻两个采样点都可见才分配这一段时间；只在单次采样里出现过的快速滚过不计入
- 看不到的部分不累计，也不因为消息在 DOM 里就认为读过
- web 额外排除 `aria-hidden`、`display/visibility/opacity` 隐藏、零尺寸和 `checkVisibility` 失败的元素
- native 额外排除 `display: "none"`、`opacity: 0`、`accessibilityElementsHidden` 和 `importantForAccessibility: "no-hide-descendants"`

### 状态清理和恢复

超过 `STATE_TTL_MS` 没再出现且没有待上传变化的 state 会从内存删除。删除前保存覆盖快照；同一会话里这条消息再次出现时恢复 dwell、覆盖和 revisit。已完成的 bin 恢复后会直接按「离开很久再回来」处理，进入回看片段，而不是重新算首次阅读。

文本版本变化时，旧 state 会从当前消息表移出。如果它还有没上传的变化，按 `(messageId, version)` 暂存在 detached 表里，等下一次上传 ACK 后再删除；同一版本重新出现时由恢复逻辑接管，避免同一份覆盖作为两个 state 重复上传。

快照表有上限，按插入顺序淘汰最旧条目。插件重启或页面刷新后内存清空，只能依赖 daemon 的跨 session 推断来识别回看。

## 平台适配

Paseo 没有公开的时间线可见性 API，插件使用 host 实现细节：

### web

- `[data-testid="assistant-message"]`：assistant 消息的 host 节点
- `[data-testid="agent-chat-scroll"]`：滚动视口
- `[data-message-id]`：`occurrenceKey` 缺失时的兜底行
- 正文和 `occurrenceKey` 从 React fiber 的 `AssistantMessage` props 读取，不从 DOM 文本拼，避免把按钮、复制提示等 UI 文本算进去
- DOM 上的 `__reactFiber$` 指针在 commit 后可能仍指向旧树；读 props 前先通过 `alternate` 和 `FiberRoot.current` 换到当前 fiber

### native

- 从侧边栏 footer 里隐藏 1x1 View 的 ref 拿 `__internalInstanceHandle`，再向上找到 root fiber，取 HostRoot 的 `current` 作为遍历起点
- 在 fiber 树里找 `testID="assistant-message"` 的 host，从祖先 `AssistantMessage` props 读正文、身份和 `phase`
- 用 Fabric host 的 `unstable_getBoundingClientRect()` 或 `getBoundingClientRect()` 拿窗口坐标
- 优先用 `testID="agent-chat-scroll"` / `nativeID="agent-chat-scroll-native-virtualized"` 的 host 当视口；找不到时退到带滚动样式的祖先，再退到包含该行的最近祖先
- 整棵树单次扫描有节点数上限；读不到位置时只打一条限频 warn，不写入错误数据

这两套都是内部实现，Paseo 升级后可能失效。选择器、props 或 fiber 结构变化时通常表现为「没有新数据」；如果组件结构变了但坐标仍然有效，也可能得到错误的可见比例，升级后需要实测校准。

## 上传和存储

### 客户端批次

`client/sampler.ts` 收集变化后发 `human-tokens.ingest`：

- `batchId` 随机生成；上传失败保留同一批次重试，daemon 按 `batchId` 去重
- 每条消息带当前覆盖、回看覆盖、累计 `revisits`、文本版本和字符数
- 批次带客户端本地日期和 5 分钟桶；活跃阅读/回看/输入时间按这个日期和桶归属，切换次数只按日期归属。旧客户端没有 5 分钟桶字段时，批次仍写消息覆盖和日汇总，不写 5 分钟桶
- daemon 事务提交后才 ACK；客户端收到成功才清 dirty，并在上传期间覆盖又变化时继续保留
- 插件停止时先等最后一批上传，再断开 RPC

### SQLite

数据库位置由 `server/db.ts` 的 `openDatabase` 决定，默认在 `PASEO_HOME/plugin-data/human-tokens/stats.sqlite`，`PASEO_HOME` 未设置时用 `~/.paseo`。

- `message_read`：按 `(messageId, version, sessionId)` 分行，保留每个客户端/会话的累计覆盖；主键不含 device，同一 session 跨设备不重复
- `day_stats`：按 `(day, deviceId)` 累加读入、回看、输入、重读和切换的日增量
- `slot_stats`：按 `(day, slot, deviceId)` 累加读入、回看、输入和活跃阅读/回看/输入时间，供当天的 288 个 5 分钟桶使用；保留 90 天
- `ingest_batch`：`batchId` 去重，保留窗口由 `server/db.ts` 决定

读取时把所有 session 的覆盖逐 bin 取最大，再折算 lifetime。日统计按客户端本地日期归属。正常上传时跨午夜最多偏一个上传间隔；上传失败或长时间离线后重新连接时，积压的活动会记到恢复当天。

### 合并规则

- 首次阅读覆盖和回看覆盖都是逐 bin 取最大
- 事件计数（输入字符、活跃时间、切换、revisits）按增量求和
- `slot_stats` 和 `day_stats` 使用同一批增量：读入/回读只记本批次让全局最大覆盖增加的部分，输入和活跃时间直接相加
- 日 `readTokens` / `missTokens` 只记录本批次让全局最大覆盖增加的部分，多设备重复上报同一覆盖不会重复累加
- 跨 session 推断的回看只在 `message_read` 里记一次，`inferred_revisit` 防止同一 message/session 重复计

## 隐私

- 消息正文只在客户端内存里参与计算，不上传、不写数据库、不写日志
- 上传的是消息身份、文本版本、字符数和每段覆盖，不包含正文
- composer prompt 同样只在客户端内存里比较长度，不保存文本
- daemon 只存 agentId 和消息 ID，不存账号标识
- 错误日志只包含错误本身，不拼接消息正文

## 已知限制

- 5 分钟数据从本版本开始记录，升级前的历史只有天粒度
- 5 分钟归属按客户端构建批次的时间；正常上传时误差在一个 `FLUSH_MS` 左右，上传失败或离线积压的增量可能集中记到少数几个桶
- 5 分钟图只支持缩放，不支持拖动平移；查看其他时段要先缩小范围，选中目标时间后再放大
- 阅读时长是按字数和可见比例估算的，不是真实眼动或滚动行为；长代码块、表格、图片多时误差更大
- 正文字符数取 AssistantMessage 的 markdown 源文本，包含 `**`、反引号等标记；图片和渲染后省略的语法不单独校正
- 快速滚过也可能因为短暂可见而累计少量覆盖，但达不到完成阈值；完成判定需要停留到估算时长
- 人离开但窗口在前台时仍会累计，没有 AFK 检测
- 边缘 bin 只按历史最大可见比例累计覆盖，没完整露出过就不会标记读完；可见部分在 bin 内移动时仍按最大比例近似，没有逐字符布局数据无法完全消除这个误差
- bin 按渲染高度切分，跨设备、不同字体或折叠状态会让同一个 bin 对应略不同的字符范围；跨设备覆盖合并因此是近似值
- 流式消息、工具调用、用户消息和未进入视口的消息不计入 AI 产出
- 原生端每 `SAMPLE_MS` 遍历一次 fiber 树，节点很多时可能增加 JS 线程开销；扫描有上限，读不到位置时静默降级
- 原生坐标依赖 Fabric 的窗口坐标；如果 Paseo 改了坐标系或组件结构，可能整体失效
- 客户端 RPC 发往当前 host；切换 host 时，切换前积累的批次可能被送到新 host
- 同一设备多个窗口只有聚焦窗口采集；电脑和手机同时使用时，`activeReadMs` / `activeTypingMs` 等时间仍会按批次相加，不计算重叠区间；字符覆盖逐 bin 取最大
- 同一 app 会话里被清理的 state 最多保留固定条数，超出后最早的快照丢失，再回看会被当成首次阅读
- 页面刷新或 app 重启后，同一会话的本地阅读状态不保留；跨 session 回看靠 daemon 推断，推断最多每个 message/session 一次
- `producedTokens` 只覆盖插件见过的消息，不能当作 agent 的完整输出统计
- 读速和回看速度在活跃时间很少时不稳定，适合看趋势，不适合当精确 benchmark
- `human-tokens.stats` 在 daemon 的事件循环里同步读取 SQLite 并扫描全部 `message_read` 行；历史数据很大时查询会变慢，也会短暂阻塞该插件进程

## 代码入口

- 指标定义和常量：`shared/protocol.ts`
- 覆盖折算：`shared/metrics.ts`
- 阅读/回看模型：`client/model.ts`
- 采样和上传：`client/sampler.ts`
- 输入采样：`client/driver.tsx`
- web DOM/fiber 适配：`client/web.ts`
- native fiber/Fabric 适配：`client/native.ts`
- SQLite 和合并：`server/db.ts`
- 页面和侧边栏：`client/screen.tsx`、`client/sidebar.tsx`

## 开发

在仓库根目录执行：

```bash
pnpm install
pnpm run lint
pnpm run typecheck
```

插件没有构建步骤，Paseo 直接编译 TypeScript。本地安装和 reload 命令见 [README.md](README.md)。
