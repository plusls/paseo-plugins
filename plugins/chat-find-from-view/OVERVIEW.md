# chat-find-from-view

聊天内 Ctrl+F 查找时，初始匹配从搜索开始前视口里的第一条可见消息附近开始，不再总是跳到会话里的第一条结果。搜索、计数、高亮和“加载更多历史”仍由 Paseo 内置查找完成。

## 行为

- 只改变初始选中的匹配。上一个、下一个仍然按全部匹配翻动
- 同一个长消息里，如果第一条匹配在视口上方，插件继续向后找，直到匹配进入搜索开始前的视口
- 合并消息的 `timelineCursor.seq` 是最后一段的序号，插件按首条可见行之前的 item 序号判断命中属于哪条显示消息，不会把同一条消息里更早的命中当成视口上方的内容跳过
- 视口下方没有匹配时，选择视口上方最近的一条匹配，不回绕到整个会话的第一条
- 选中点本来就在搜索开始前的视口里时，Paseo 为了把匹配滚到查找栏下方产生的滚动不会生效，页面完全没有动过；最终匹配不在视口里时，插件在定位结束后只滚一次。目标消息还没渲染时仍由 Paseo 自己滚动挂载
- 连续输入多个字符时沿用第一次输入时的视口，不把上一字符搜索造成的滚动当成新基准。第一个字符不经过包装后的 `setQuery`，由 `searching` 状态订阅补采
- 清空查询后重新输入，会重新采样视口
- 不注册界面，不采集数据，不发网络请求

## 工作方式

`client/adapter.ts` 等待查找浮层出现，从 React fiber 里拿到内部 `ChatFindModel`，包装它的 `setQuery` 和 `navigate`。

`setQuery` 在查询发出前记录视口：第一条可见行的 `timelineCursor.seq`、它之前一个 item 的序号、滚动位置，以及视口上下边缘的两个 DOM 锚点。`navigate(0, 1)` 是搜索完成后的初始定位，插件取第一个序号大于首条可见行之前 item 序号的匹配；如果后面没有匹配，就取最后一条并从它的最后一次匹配开始。

Paseo 用 `Highlight` 标记当前匹配。插件通过 `CSS.highlights` 读取匹配的 DOM Range，用 `Range.compareBoundaryPoints` 判断它是否仍完全在原视口上方。是就调用 `model.next()` 继续前进。目标消息已经渲染时，初始定位期间把滚动容器的 `scrollTop` 固定在当前位置，写入和读取都返回这个快照值；最终匹配与原视口重叠时先解除冻结再恢复原滚动位置，页面停在原位置，匹配在视口外时按 highlight 的屏幕位置滚一次到查找栏下方。目标消息还没挂载时不冻结，因为滚动是虚拟列表挂载它的必要手段。Paseo 丢弃没有可高亮匹配的 location 并回绕时，插件检测到选中位置倒退，退回步进前的那条消息。

插件卸载或 reload 时会把 `navigate` 和 `setQuery` 换回原方法，取消 `searching` 状态订阅，并解除所有滚动冻结，因此禁用插件后不需要刷新客户端就能回到原生查找行为。

## 限制

- 依赖 `ChatFindModel` 的私有字段、ChatFind 的 hook 结构、`data-chat-find-widget`、`data-history-row-id`、`agent-chat-scroll` 和 `CSS.highlights` 里的 `paseo-chat-find-` 前缀。这些是 Paseo 内部实现，升级后可能失效
- 可见行要求至少露出 `MIN_VISIBLE_ROW_PX`（见 `client/adapter.ts`）。吸顶工具栏、CSS 变换或折叠状态可能让“第一条可见消息”与视觉上的第一条略有差异
- 视口上方匹配较多时，定位会依次调用 `next`，计数会先经过这些匹配再稳定下来；目标消息已经挂载时页面不动，步进到另一条消息时会解冻并由 Paseo 滚动到那条消息
- 视口锚点依赖 `document.caretPositionFromPoint`、`document.createRange` 和 `Range.compareBoundaryPoints`。缺少这些 API 时退回文档坐标，页面已经滚动后判断可能不准确
- 流式消息、插件行或尚未挂载的行可能没有 `timelineCursor`，插件会顺延到下一行；没有可映射的行时回到原生行为
- 只在 web 和 Electron 生效。native 端没有 DOM，插件不执行任何操作
- 插件不保存数据，不读消息正文，不写日志中的查询内容
