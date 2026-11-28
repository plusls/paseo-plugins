# chat-find-from-view

Paseo 本地插件原型：聊天内 Ctrl+F 查找时，初始匹配从当前视口的第一条可见消息开始，上一个、下一个仍然按全部匹配翻动。

## 做什么

- 只改变初始选中的匹配。搜索、结果计数、加载和高亮仍由 Paseo 内置查找完成；初始定位期间冻结滚动，匹配本来就在原视口里时页面完全不动
- 保留全部匹配。插件不改变 `locations`，也不改变上一个、下一个的行为
- 同一个长消息里可能有更早的匹配位于视口上方。插件按搜索开始前的视口继续向后找，直到匹配点不再完全位于视口上方
- 合并消息的 `timelineCursor.seq` 是最后一段的序号。插件把首条可见行之前的 item 序号作为基准，按 `location.seq` 是否大于它判断命中属于哪条显示消息，不会把同一条合并消息里更早的命中当成视口上方的内容跳过
- 当前视口第一条可见行没有 `timelineCursor.seq` 时，顺延到下一行；所有可见行都无法映射时，保留原生行为
- 顶部只露出几像素的残行视为视口上方的内容，不作为第一条可见行；阈值见 `client/adapter.ts` 的 `MIN_VISIBLE_ROW_PX`
- 视口下方没有匹配时，选择视口上方最近的一条匹配，不回绕到整个会话的第一条
- 选中的匹配本来就在搜索开始前的视口里时，Paseo 为了把匹配滚到查找栏下方产生的滚动不会生效，页面没有先滚走再回来的过程；最终匹配不在视口里时，插件在定位结束后只滚一次到匹配。目标消息还没渲染时仍由 Paseo 自己滚动挂载
- 连续输入多个字符时沿用打开查找时的视口和滚动位置，不把上一字符搜索造成的滚动当成新基准
- 不注册界面，不采集数据，不发网络请求

## 安装

要求 Paseo 0.17.1 或更高版本，只在 web 和 Electron 上生效。native 端没有 DOM，插件会直接返回空清理函数，内置查找不受影响。

从本地目录安装：

```bash
paseo plugin install "$PWD/plugins/chat-find-from-view"
```

同一 daemon 已安装同 ID 插件时先执行：

```bash
paseo plugin remove chat-find-from-view
```

安装后打开或刷新客户端。如果客户端缓存了旧插件代码，刷新页面或重新打开应用。

本地开发时修改代码后执行：

```bash
paseo plugin reload chat-find-from-view
```

查看插件侧输出：

```bash
paseo plugin logs chat-find-from-view
```

卸载：

```bash
paseo plugin remove chat-find-from-view
```

目录插件只删除配置，不删除源码目录。

## 实现方式

`client/adapter.ts` 用一个 `MutationObserver` 等待 `[data-chat-find-widget="true"]` 出现，然后：

1. 从浮层的 `__reactFiber$` 指针向上找到 ChatFind 组件，读取它的 hook 里的 `ChatFindModel`
2. 包装 `setQuery`：非空查询开始时按当前视口建立会话，记录第一条可见行的 `timelineCursor.seq`、它之前一个 item 的序号、滚动位置和 DOM 锚点；清空查询时丢弃会话。查找面板第一次渲染时拿到的是原始 `setQuery`，所以同时订阅模型进入 `searching` 的状态，在查询发出时补采
3. 再包装 `navigate`，只拦截 `navigate(0, 1, signal)`，也就是搜索完成后第一次选中匹配
4. 拦截时找到 ChatFind 的 root 和 `[data-testid="agent-chat-scroll"]`，按 `[data-history-row-id]` 和 `getBoundingClientRect()` 取视口内最靠上、至少露出 `MIN_VISIBLE_ROW_PX` 的可见行
5. 优先用会话里保存的序号；没有时用当前视口。取 `model.locations` 里第一个序号大于首条可见行之前 item 序号的索引。如果后面没有匹配，就取最后一条并让 `navigate` 从这条消息的最后一次匹配开始
6. 目标消息已经渲染在 DOM 里时，把滚动容器的 `scrollTop` 固定在当前位置，写入不生效、读取也返回这个快照值。消息还没挂载时不冻结，因为滚动是虚拟列表挂载它的必要手段
7. 用这个索引调用原始 `navigate`
8. 原始 `navigate` 完成后读取 Paseo 的 CSS highlight，用 `Range.compareBoundaryPoints` 判断匹配是否仍完全在原视口锚点上方；是就调用 `model.next()` 继续前进，直到匹配进入原视口；已经到最后一条匹配时停下，不再绕回第一条
9. 步进到另一条消息前先解除冻结，让 Paseo 能滚动挂载那条消息
10. 定位结束时解除冻结。最终匹配与原视口重叠时先解除冻结再恢复原滚动位置，页面停在原位置；匹配在视口外时按 highlight 的屏幕位置滚一次到查找栏下方
11. 如果后面的 location 渲染后没有可高亮的匹配，Paseo 会丢弃它并回绕到前面的消息；插件检测到选中位置倒退时退回步进前的那条消息，停在上方最近的一条匹配

Paseo 用 `Highlight` 标记当前匹配，Highlight 不在 DOM 树里，所以第 8 步通过 `CSS.highlights` 读取匹配位置。用 DOM 锚点而不是 `getBoundingClientRect()` 的文档坐标，是因为滚动和虚拟列表布局变化会让坐标漂移。锚点 API 不可用、或者锚点所在的行已经被虚拟列表卸载时，退回文档坐标判断。

冻结把 `scrollTop` 的读写都固定在加锁时的值，`scrollTo` 不受影响。只有目标消息已经挂载时才会冻结，此时 Paseo 的 `scrollToMessage` 走已挂载分支，不需要虚拟列表滚动；冻结期间匹配位置从 DOM 读取，布局没有移动，判断和最后定位都基于同一个屏幕位置。定位结束时先中止滚动动画并解除冻结，再按真实位置计算落点。

observer 只在新增节点本身或子树里包含查找浮层时才安排探测，时间线流式输出不会反复走 React fiber。

用户输入每个字符都会触发一次搜索和 `navigate`。插件用浮层 DOM 节点作为会话边界，同一浮层内沿用第一次搜索前的视口、首条可见行和滚动位置，关闭再打开后重新采样。第一个字符不经过包装后的 `setQuery`，由 `searching` 状态订阅补采，保证搜索期间的滚动不会变成新基准。快速输入时，旧 `navigate` 的定位结果会被丢弃，只保留最新一次。

浮层会在查找关闭时卸载，ChatFind 的 root 不会。插件把 root 而不是浮层节点保存在 WeakMap 里，关闭再打开后仍然能找到当前时间线。

插件用 `Set<WeakRef>` 和 `Symbol.for("paseo.chatFindFromView.patched")` 记录已包装的 model，WeakRef 避免插件运行期间强引用所有打开过的聊天。其他参数组合、找不到视口或找不到可见行时直接调用原始 `navigate`；只有抛错时 `console.warn` 一次，插件运行期间最多一次。卸载或 reload 时解除所有滚动冻结、把 `navigate` 和 `setQuery` 换回原方法并删除标记。

## 限制

- 依赖 ChatFindModel 的字段 `locations`、`items`、`inMessage`、`current`、`resultEpoch` 和 `abort`，ChatFind 的 hook 结构，`data-chat-find-widget`、`data-history-row-id`、`data-message-id`、`agent-chat-scroll`，以及 `CSS.highlights` 里的 `paseo-chat-find-` 前缀。这些是 Paseo 内部实现，升级后可能失效。`abort` 改名会让插件无法中止 reveal 的 settle 动画，表现为定位结束后页面仍可能继续滚动
- 合并消息的归属判断沿用 Paseo 的 `before < location.seq` 规则。如果 Paseo 改变客户端合并消息的方式，这条判断需要跟着调整
- 只改变初始匹配位置，以及匹配本来就在原视口里时的滚动恢复。当前匹配计数、高亮和“加载更多历史”仍按内置逻辑执行
- 可见行按 `getBoundingClientRect()` 和滚动视口相交判断，并要求至少露出 `MIN_VISIBLE_ROW_PX`。吸顶工具栏、CSS 变换或折叠状态可能让“第一条可见消息”与视觉上的第一条略有差异
- 定位阶段会依次调用 Paseo 的 `next`。同一个长消息里视口上方的匹配较多时，计数会先经过这些匹配再稳定下来；目标消息已经挂载时页面不动，步进到另一条消息时会解冻并由 Paseo 滚到那条消息
- 如果 `CSS.highlights` 不可用或高亮名称变化，插件会跳过后面的定位，只按可见消息选择，长消息里仍可能选中视口上方的更早匹配
- 视口锚点依赖 `document.caretPositionFromPoint`、`document.createRange` 和 `Range.compareBoundaryPoints`。浏览器没有这些 API 时退回文档坐标，页面已经为把匹配滚到查找栏下方而滚动后，判断可能不准确
- 会话边界取查找浮层的 DOM 节点。Paseo 如果改成关闭后保留同一个浮层节点，插件会把关闭前的视口继续当成基准，需要重新打开或刷新客户端
- 流式消息、插件行或尚未挂载的行可能没有 `timelineCursor`，插件会顺延到下一行；如果没有可映射的行，就回到原生行为
- 搜索结果由 daemon 提供。用户消息、通知等是否出现在结果里取决于内置搜索；插件只在这些结果中找第一个不早于视口的匹配
- 查找浮层一直开着、时间线内容只发生文本更新时，`MutationObserver` 可能不会重新探测新 model。关闭再打开查找即可；切换 agent 时 Paseo 本身会关闭浮层
- 只在 web 和 Electron 生效。native 端不加载 DOM，插件为 no-op
- 插件不保存数据，不读消息正文，不写日志中的查询内容。结构错误只输出一次错误对象

## 验证

在本地 dev daemon（0.17.1）和 app.paseo.sh（v0.18.1）上手动验证：

- 视口停在一条较长的 assistant 消息中段，查询 `消息` 共命中 10 次。原生从第一条匹配开始，插件从搜索开始前视口附近的第一条匹配开始（示例为 `8 / 10`），页面滚动位置不变
- 在同一场景逐帧记录 `scrollTop`，初始定位全程只有起始值，没有先滚走再回来的帧
- 视口下方没有匹配、匹配只在上方时，插件选中离视口最近的上一条匹配，不回绕到整个会话的第一条。查询只有一条上方匹配时，最终 `scrollTop` 停在匹配位置，不回到会话开头
- 视口在会话底部、当前长消息里还有多条匹配时，插件选中最后一条（`10 / 10`），滚动位置不变
- 连续输入两个字符时，第二个字符沿用打开查找时的视口，不会停在中间某条匹配
- 在同一个 10 条命中的场景点“上一个匹配项”显示 `7 / 10`，点“下一个匹配项”回到 `8 / 10`
- 先确认插件显示 `8 / 10`，执行 `paseo plugin disable chat-find-from-view` 后不刷新客户端，关闭再打开查找，查询回到原生初始行为 `1 / 10`；重新启用后，在长消息中段再查显示 `8 / 10`，滚动位置不变
- 视口停在一条较长的 assistant 消息上，查询同时命中更早的用户消息和当前消息。原生会从更早的匹配开始，插件显示 `2 / 2`，从当前消息开始
- 点“上一个匹配项”回到更早匹配，显示 `1 / 2`；点“下一个匹配项”回到当前匹配，显示 `2 / 2`
- 关闭查找，把视口重新停在同一条消息上，再打开查找，仍显示 `2 / 2`
- 查询无匹配内容时显示“无匹配项”，不抛错
- 同一 workspace 下切换两个 agent，查找浮层关闭；在新 agent 上打开查找，插件重新包装新 model，没有崩溃
- 插件运行期间没有出现插件自己的 `console.warn`

验证过程中使用的会话内容没有写入仓库，验证截图也没有提交。

## 开发

在 monorepo 根目录执行：

```bash
pnpm install
pnpm run lint
pnpm run typecheck
```

插件没有构建步骤。Paseo 直接编译 TypeScript，目录安装后执行 `paseo plugin reload chat-find-from-view` 即可。插件入口是 `index.client.tsx`，实现和注释在 `client/adapter.ts`。
