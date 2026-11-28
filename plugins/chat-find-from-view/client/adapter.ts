/**
 * 聊天内 Ctrl+F 的初始匹配默认从第一条结果开始。这个插件包装
 * ChatFindModel.setQuery 和 ChatFindModel.navigate(0, 1)：输入查询时记录
 * 当前视口，初始导航时把索引改成视口第一条可见消息对应的第一个匹配；同一个
 * 长消息里如果第一条匹配还在视口上方，会继续前进到视口附近。下方没有匹配时
 * 停在最近的先前匹配，不回绕第一条。搜索、加载和高亮仍走内置实现；初始定位
 * 期间冻结滚动容器，匹配本来就在原视口里时页面完全不动，最终匹配在视口外时
 * 只在定位结束后滚一次。卸载或 reload 时恢复两个方法，避免旧包装继续生效。
 *
 * Paseo 没有公开 ChatFindModel，也没有公开“当前可见消息”的 API。这里依赖：
 * - [data-chat-find-widget="true"]：查找浮层
 * - [data-history-row-id]：时间线行，值是 StreamItem.id
 * - [data-message-id]：消息行，用来判断目标消息是否已经挂载
 * - [data-testid="agent-chat-scroll"]：滚动视口
 * - 浮层 DOM 节点的 __reactFiber$ 和 ChatFind 的 useMemo hook
 * - ChatFindModel 的私有字段 locations、items、inMessage、current、
 *   resultEpoch 和 abort
 * - CSS.highlights 里 paseo-chat-find- 前缀的当前匹配，用来比较匹配位置
 *
 * 这些都是内部实现，升级后可能失效。任何一步找不到或抛错时都保留原生行为，
 * 不阻断查找；结构错误只告警一次。
 */

interface WebRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  height: number;
}

interface WebNode {
  readonly parentElement: WebElement | null;
  readonly isConnected?: boolean;
}

interface WebRange {
  readonly startContainer: WebNode | null;
  getBoundingClientRect(): WebRect;
  setStart(node: WebNode, offset: number): void;
  collapse(toStart?: boolean): void;
  compareBoundaryPoints(how: number, source: WebRange): number;
}

interface WebCaretPosition {
  readonly offsetNode: WebNode;
  readonly offset: number;
}

interface WebHighlight {
  forEach(callback: (range: WebRange) => void): void;
}

interface WebHighlightRegistry {
  forEach(callback: (highlight: WebHighlight, name: string) => void): void;
}

interface WebElement {
  [key: string]: unknown;
  scrollTop: number;
  getAttribute(name: string): string | null;
  getBoundingClientRect(): WebRect;
  contains(node: WebNode): boolean;
  querySelector(selector: string): WebElement | null;
  querySelectorAll(selector: string): ArrayLike<WebElement>;
  readonly parentElement: WebElement | null;
}

interface WebDocument {
  readonly body: WebElement | null;
  querySelector(selector: string): WebElement | null;
  querySelectorAll(selector: string): ArrayLike<WebElement>;
  createRange?: () => WebRange;
  caretPositionFromPoint?: (x: number, y: number) => WebCaretPosition | null;
}

interface WebMutationRecord {
  readonly addedNodes: ArrayLike<WebNodeWithQuery>;
}

interface WebNodeWithQuery {
  readonly nodeType: number;
  matches?: (selector: string) => boolean;
  querySelector?: (selector: string) => WebElement | null;
}

interface WebMutationObserver {
  observe(
    target: WebElement,
    options: { childList: true; subtree: true },
  ): void;
  disconnect(): void;
}

interface MutationObserverConstructor {
  new (callback: (records: WebMutationRecord[]) => void): WebMutationObserver;
}

interface BrowserGlobals {
  document?: WebDocument;
  MutationObserver?: MutationObserverConstructor;
  CSS?: { highlights?: WebHighlightRegistry };
}

interface FiberNode {
  readonly return: FiberNode | null;
  readonly alternate?: FiberNode | null;
  readonly stateNode?: unknown;
  readonly memoizedState: unknown;
}

interface HookNode {
  readonly memoizedState: unknown;
  readonly next: HookNode | null;
}

interface ChatFindSnapshot {
  phase: string;
  query: string;
  selectedItemId: string | null;
  occurrence: number;
  count: number;
}

/**
 * 初始定位期间冻结滚动容器。Paseo 的 reveal 会先把消息顶部滚到查找栏下方，
 * 再按匹配调整；如果最终匹配本来就在视口里，这段滚动会被用户看见，之后再
 * 撤销就是一次闪烁。冻结期间 Paseo 的 scrollTop 写入不生效，匹配位置用 DOM
 * 读取，最后按结果决定保留原位置还是只滚一次到匹配。
 */
interface ScrollLock {
  readonly active: boolean;
  release(): void;
}

interface ChatFindModelLike {
  navigate: (...args: unknown[]) => Promise<unknown>;
  setQuery: (...args: unknown[]) => unknown;
  locations: unknown[];
  items: unknown[];
  next?: () => void;
  subscribe?: (listener: () => void) => () => void;
  getSnapshot?: () => ChatFindSnapshot;
}

const WIDGET_SELECTOR = '[data-chat-find-widget="true"]';
const SCROLL_SELECTOR = '[data-testid="agent-chat-scroll"]';
const ROW_SELECTOR = "[data-history-row-id]";
// 只露出几像素的吸顶残行属于视口上方的内容，按它定位会把页面拽回上一段。
const MIN_VISIBLE_ROW_PX = 24;
const PATCHED = Symbol.for("paseo.chatFindFromView.patched");

interface ModelPatch {
  readonly originalNavigate: ChatFindModelLike["navigate"];
  readonly patchedNavigate: ChatFindModelLike["navigate"];
  readonly originalSetQuery: ChatFindModelLike["setQuery"];
  readonly patchedSetQuery: ChatFindModelLike["setQuery"];
  readonly unsubscribe?: () => void;
}

// 用 WeakRef 记录已包装的 model，避免插件生命周期内强引用所有打开过的聊天。
// 原始方法放在 WeakMap 里，卸载时逐个恢复。
const PATCHED_MODELS = new Set<WeakRef<ChatFindModelLike>>();
const PATCH_INFO = new WeakMap<ChatFindModelLike, ModelPatch>();
// 插件安装期间为 true。卸载后仍在等待的定位流程要能自己停下。
let ACTIVE = false;
// ChatFind 的浮层会随查找关闭而卸载，root 不会；把 root 而不是浮层节点
// 固定在 patch 里，关闭再打开后仍能找到当前时间线。
const MODEL_ROOTS = new WeakMap<object, WebElement>();

let warned = false;

function warnOnce(error: unknown): void {
  if (warned) return;
  warned = true;
  console.warn(
    "[chat-find-from-view] 读取查找浮层失败，继续使用原生查找行为",
    error,
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isAborted(signal: unknown): boolean {
  return isRecord(signal) && signal.aborted === true;
}

function containsWidget(node: WebNodeWithQuery): boolean {
  if (node.nodeType !== 1) return false;
  try {
    if (node.matches?.(WIDGET_SELECTOR)) return true;
    return !!node.querySelector?.(WIDGET_SELECTOR);
  } catch {
    return false;
  }
}

function isChatFindModel(value: unknown): value is ChatFindModelLike {
  if (!isRecord(value)) return false;
  return (
    typeof value.navigate === "function" &&
    typeof value.setQuery === "function" &&
    Array.isArray(value.locations) &&
    Array.isArray(value.items)
  );
}

function isCurrentFiber(fiber: FiberNode): boolean {
  let top = fiber;
  for (let depth = 0; top.return && depth < 200; depth += 1) {
    top = top.return;
  }
  const root = top.stateNode as { current?: FiberNode | null } | null;
  return root?.current === top;
}

/**
 * DOM 节点上的 __reactFiber$ 在 commit 后可能仍指向上一次提交的树。
 * ChatFind 的 useMemo 只在 agent 或 server 变化时重建，旧树里的 model
 * 不是当前界面正在用的那个，必须先换到当前 fiber。
 */
function resolveCurrentFiber(fiber: FiberNode): FiberNode {
  if (isCurrentFiber(fiber)) return fiber;
  if (fiber.alternate && isCurrentFiber(fiber.alternate)) return fiber.alternate;
  return fiber;
}

function fiberFromNode(node: WebElement): FiberNode | null {
  const key = Object.keys(node).find((candidate) =>
    candidate.startsWith("__reactFiber$"),
  );
  if (!key) return null;
  const value = node[key];
  return isRecord(value) ? (value as unknown as FiberNode) : null;
}

function modelInHookValue(value: unknown): ChatFindModelLike | null {
  if (isChatFindModel(value)) return value;
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (isChatFindModel(entry)) return entry;
    }
    return null;
  }
  if (isRecord(value) && isChatFindModel(value.current)) return value.current;
  return null;
}

function modelInHooks(hooks: unknown): ChatFindModelLike | null {
  let hook = hooks as HookNode | null;
  for (let count = 0; hook && isRecord(hook) && count < 100; count += 1) {
    const model = modelInHookValue(hook.memoizedState);
    if (model) return model;
    hook = hook.next;
  }
  return null;
}

function modelFromWidget(widget: WebElement): ChatFindModelLike | null {
  // 浮层 div 上通常直接有 fiber；没有时再向父节点找，最多几层。
  let node: WebElement | null = widget;
  for (let depth = 0; node && depth < 5; depth += 1) {
    const pointer = fiberFromNode(node);
    if (pointer) {
      let fiber: FiberNode | null = resolveCurrentFiber(pointer);
      for (let up = 0; fiber && up < 60; up += 1) {
        const model = modelInHooks(fiber.memoizedState);
        if (model) return model;
        fiber = fiber.return;
      }
    }
    node = node.parentElement;
  }
  return null;
}

function rootOfWidget(widget: WebElement): WebElement | null {
  let node: WebElement | null = widget;
  for (let depth = 0; node && depth < 20; depth += 1) {
    if (node.getAttribute("data-testid") === "agent-chat-scroll") return node;
    if (node.querySelector(SCROLL_SELECTOR)) return node;
    node = node.parentElement;
  }
  return null;
}

function scrollOfRoot(root: WebElement): WebElement | null {
  if (root.getAttribute("data-testid") === "agent-chat-scroll") return root;
  return root.querySelector(SCROLL_SELECTOR);
}

interface VisibleCursor {
  readonly seq: number;
  readonly epoch: unknown;
}

function cursorForItem(items: unknown[], id: string): VisibleCursor | null {
  for (const item of items) {
    if (!isRecord(item) || item.id !== id) continue;
    const cursor = item.timelineCursor;
    if (!isRecord(cursor)) continue;
    const seq = cursor.seq;
    if (typeof seq === "number" && Number.isFinite(seq)) {
      return { seq, epoch: cursor.epoch };
    }
  }
  return null;
}

/**
 * 取视口内最靠上的、能映射到 timelineCursor.seq 的行。
 * 流式行或插件行可能还没有 cursor，此时顺延到下一行；都没有就交回原生行为。
 */
function visibleRowCursor(scroll: WebElement, items: unknown[]): VisibleCursor | null {
  const viewport = scroll.getBoundingClientRect();
  if (!(viewport.height > 0)) return null;

  const visible: { row: WebElement; top: number }[] = [];
  const rows = scroll.querySelectorAll(ROW_SELECTOR);
  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index];
    if (!row) continue;
    const rect = row.getBoundingClientRect();
    if (!(rect.height > 0)) continue;
    const visibleHeight =
      Math.min(rect.bottom, viewport.bottom) - Math.max(rect.top, viewport.top);
    if (!(visibleHeight >= MIN_VISIBLE_ROW_PX)) continue;
    visible.push({ row, top: rect.top });
  }
  visible.sort((left, right) => left.top - right.top);

  for (const entry of visible) {
    const id = entry.row.getAttribute("data-history-row-id");
    if (!id) continue;
    const cursor = cursorForItem(items, id);
    if (cursor) return cursor;
  }
  return null;
}

/**
 * 首条可见行之前最近一个 item 的 seq。合并消息的 cursor 是最后一段的 seq，
 * 同一条显示消息里更早的 location 会小于首条可见行的 seq；只比较 seq 会把
 * 这条消息里的命中误判到视口下方。Paseo 在 ChatFindModel.target() 里用
 * before < location.seq 判断 location 属于哪条显示消息，这里沿用同一条规则。
 */
function seqBefore(items: unknown[], seq: number, epoch: unknown): number | null {
  let before: number | null = null;
  for (const item of items) {
    if (!isRecord(item)) continue;
    const cursor = item.timelineCursor;
    if (!isRecord(cursor) || cursor.epoch !== epoch) continue;
    const candidate = cursor.seq;
    if (typeof candidate !== "number" || !Number.isFinite(candidate)) continue;
    if (candidate >= seq) continue;
    before = before === null ? candidate : Math.max(before, candidate);
  }
  return before;
}

function firstLocationAhead(locations: unknown[], floor: number, strict: boolean): number {
  for (let index = 0; index < locations.length; index += 1) {
    const location = locations[index];
    if (!isRecord(location)) continue;
    const locationSeq = location.seq;
    if (
      typeof locationSeq === "number" &&
      Number.isFinite(locationSeq) &&
      (strict ? locationSeq > floor : locationSeq >= floor)
    ) {
      return index;
    }
  }
  // 视口之后没有匹配，交给调用方从最后一条向前找
  return -1;
}

function targetIndex(
  model: ChatFindModelLike,
  scroll: WebElement,
  savedSeq: number | null,
  savedBefore: number | null,
): { index: number; direction: 1 | -1 } | null {
  // 会话里保存的 seq 来自第一次输入查询时的视口。后续字符不能看已经滚过的
  // 实时视口，否则退格放宽查询时会跳过原视口上方的匹配。
  let seq = savedSeq;
  let before = savedBefore;
  if (seq === null) {
    const cursor = visibleRowCursor(scroll, model.items);
    if (!cursor) return null;
    seq = cursor.seq;
    before = seqBefore(model.items, cursor.seq, cursor.epoch);
  }
  if (model.locations.length === 0) return null;
  // 首条可见行之前没有已加载的 item 时，无法判断合并消息覆盖到哪里，
  // 退回按 seq 比较。否则用一个小于所有 location 的基准会把视口上方、
  // 只是尚未加载的命中也当成首条可见消息的匹配。
  const ahead =
    before === null
      ? firstLocationAhead(model.locations, seq, false)
      : firstLocationAhead(model.locations, before, true);
  if (ahead >= 0) return { index: ahead, direction: 1 };
  // 后面没有匹配时，最后一条就是离视口最近的先前匹配。
  // direction -1 让 Paseo 从这条消息的最后一次匹配开始。
  return { index: model.locations.length - 1, direction: -1 };
}

function hasMountedMessageRow(scroll: WebElement, id: string): boolean {
  const rows = scroll.querySelectorAll("[data-message-id]");
  for (let index = 0; index < rows.length; index += 1) {
    if (rows[index]?.getAttribute("data-message-id") === id) return true;
  }
  return false;
}

/**
 * 按 Paseo 的 ChatFindModel.target(location, false) 规则找 location 对应的
 * 显示消息。合并消息的 cursor 是最后一段的 seq，location 的 seq 可能更小，
 * 不能用 cursor.seq === location.seq 判断。
 */
function targetMessageId(
  model: ChatFindModelLike,
  location: Record<string, unknown>,
): string | null {
  const seq = location.seq;
  const role = location.role;
  if (typeof seq !== "number" || typeof role !== "string") return null;
  const epoch = (model as unknown as Record<PropertyKey, unknown>).resultEpoch;
  for (const item of model.items) {
    if (!isRecord(item)) continue;
    const cursor = item.timelineCursor;
    if (!isRecord(cursor) || cursor.epoch !== epoch) continue;
    const itemSeq = cursor.seq;
    if (typeof itemSeq !== "number" || itemSeq < seq) continue;
    if (item.kind === `${role}_message`) {
      return typeof item.id === "string" ? item.id : null;
    }
    // 用户消息是硬边界，后面的 assistant 回复不算这条 location。
    if (item.kind === "user_message") return null;
  }
  return null;
}

/**
 * 选中位置对应的消息已经渲染在 DOM 里时，Paseo 的 reveal 不需要滚动就能找到
 * 行和匹配。只有这种情况才冻结滚动；消息还没挂载时，滚动是虚拟列表挂载它的
 * 必要手段，不能拦。
 */
function targetMessageMounted(
  model: ChatFindModelLike,
  scroll: WebElement,
  index: number,
): boolean {
  const location = model.locations[index];
  if (!isRecord(location)) return false;
  const id = targetMessageId(model, location);
  return id !== null && hasMountedMessageRow(scroll, id);
}

/**
 * move(1) 在当前消息的最后一次匹配之后会调用 navigate 跳到下一条消息。
 * 那条消息可能还没挂载，跳转前必须解冻滚动，让 Paseo 自己把它滚进虚拟列表。
 */
function nextLeavesMessage(model: ChatFindModelLike): boolean {
  const inMessage = (model as unknown as Record<PropertyKey, unknown>).inMessage;
  if (!isRecord(inMessage)) return true;
  const occurrence = inMessage.occurrence;
  const count = inMessage.count;
  if (typeof occurrence !== "number" || typeof count !== "number") return true;
  return occurrence >= count - 1;
}

function currentLocation(model: ChatFindModelLike): unknown {
  const current = (model as unknown as Record<PropertyKey, unknown>).current;
  if (typeof current !== "number" || current < 0) return null;
  return model.locations[current] ?? null;
}

/**
 * 冻结滚动时读最终匹配的屏幕位置，算出取消冻结后应该落到的 scrollTop。
 * 匹配已经在查找栏下方且完整可见时返回 null，保持原滚动位置。
 */
function selectedMatchScrollTop(
  globals: BrowserGlobals,
  scroll: WebElement,
  session: FindSession,
): number | null {
  const range = selectedMatchRange(globals, scroll);
  if (!range) return null;
  const rect = range.getBoundingClientRect();
  const container = scroll.getBoundingClientRect();
  const clearance = Math.max(0, session.clearTop - session.viewportTop);
  const landing = container.top + clearance + 8;
  if (rect.top >= landing - 1 && rect.bottom <= container.bottom) return null;
  return scroll.scrollTop + rect.top - landing;
}

const RANGE_START_TO_START = 0;
const RANGE_END_TO_START = 3;

interface ViewAnchors {
  top: WebCaretPosition;
  bottom: WebCaretPosition;
}

/**
 * 一次查找会话的原视口。用户输入每个字符都会触发一次搜索和 navigate，
 * 后续字符必须沿用第一次搜索前的视口；否则第一次搜索产生的滚动会被
 * 当成新的基准，长消息里会停在中间某条匹配上。
 */
interface FindSession {
  readonly widget: WebElement | null;
  readonly scroll: WebElement;
  readonly seq: number | null;
  readonly beforeSeq: number | null;
  readonly viewportTop: number;
  readonly viewportBottom: number;
  readonly clearTop: number;
  readonly scrollTop: number;
  readonly anchors: ViewAnchors | null;
  generation: number;
}

const SESSIONS = new WeakMap<object, FindSession>();
const SCROLL_LOCKS = new Set<ScrollLock>();
const SCROLL_LOCK_STATES = new WeakMap<object, ScrollLockState>();

/**
 * 一次冻结对应滚动元素上的一个属性覆盖。快速输入时多次定位可能重叠，
 * 后开始的定位接管所有权；旧定位结束时不能提前解冻，也不能在解冻后
 * 残留自己的旧属性描述符。
 */
interface ScrollLockState {
  readonly scroll: WebElement;
  readonly previous: PropertyDescriptor | undefined;
  readonly value: number;
  owner: ScrollLock | null;
}

function createScrollLock(state: ScrollLockState): ScrollLock {
  const lock: ScrollLock = {
    get active() {
      return state.owner === lock;
    },
    release() {
      SCROLL_LOCKS.delete(lock);
      if (state.owner !== lock) return;
      state.owner = null;
      SCROLL_LOCK_STATES.delete(state.scroll);
      try {
        if (state.previous) Object.defineProperty(state.scroll, "scrollTop", state.previous);
        else delete (state.scroll as unknown as Record<PropertyKey, unknown>).scrollTop;
      } catch {
        // 滚动元素已被移除时恢复属性失败，不影响原生滚动。
      }
    },
  };
  return lock;
}

function lockScroll(scroll: WebElement): ScrollLock | null {
  const existing = SCROLL_LOCK_STATES.get(scroll);
  if (existing) {
    const lock = createScrollLock(existing);
    existing.owner = lock;
    SCROLL_LOCKS.add(lock);
    return lock;
  }
  const previous = Object.getOwnPropertyDescriptor(scroll, "scrollTop");
  const state: ScrollLockState = {
    scroll,
    previous,
    value: scroll.scrollTop,
    owner: null,
  };
  try {
    Object.defineProperty(scroll, "scrollTop", {
      configurable: true,
      get: () => state.value,
      set: () => {},
    });
  } catch {
    return null;
  }
  SCROLL_LOCK_STATES.set(scroll, state);
  const lock = createScrollLock(state);
  state.owner = lock;
  SCROLL_LOCKS.add(lock);
  return lock;
}

/**
 * 选中匹配的 DOM 位置只能从 CSS highlight 读。Paseo 用 Highlight 标记当前匹配，
 * Highlight 不在 DOM 树里，普通 querySelector 找不到。
 */
function selectedMatchRange(
  globals: BrowserGlobals,
  scroll: WebElement,
): WebRange | null {
  const registry = globals.CSS?.highlights;
  if (!registry) return null;
  const found: WebRange[] = [];
  registry.forEach((highlight, name) => {
    if (!name.startsWith("paseo-chat-find-")) return;
    highlight.forEach((range) => {
      const container = range.startContainer?.parentElement;
      // 保留面板也有自己的 ChatFind 和 highlight，只读当前滚动视口里的那个。
      if (!container || !scroll.contains(container)) return;
      if (range.getBoundingClientRect().height > 0) found.push(range);
    });
  });
  return found[0] ?? null;
}

/**
 * 在搜索开始前保存原视口上下边缘的 DOM 位置。之后即使滚动和内容高度变了，
 * Range 比较仍按文档顺序判断匹配原来是否在视口里，不受坐标漂移影响。
 */
function viewAnchors(
  globals: BrowserGlobals,
  scroll: WebElement,
  viewport: WebRect,
  clearTop: number,
): ViewAnchors | null {
  const document = globals.document;
  if (!document?.caretPositionFromPoint) return null;
  const x = Math.round((viewport.left + viewport.right) / 2);
  const top = document.caretPositionFromPoint(x, Math.round(clearTop + 2));
  const bottom = document.caretPositionFromPoint(x, Math.round(viewport.bottom - 2));
  if (!top || !bottom) return null;
  // 浮层、toast 等覆盖在聊天上方时，取到的节点不在滚动容器里，比较文档顺序
  // 会得到错误结果；这种情况退回文档坐标。
  if (!scroll.contains(top.offsetNode) || !scroll.contains(bottom.offsetNode)) {
    return null;
  }
  return { top, bottom };
}

/**
 * 在输入查询时记录视口，而不是等搜索结果返回后。搜索期间用户可能已经滚动，
 * 那时再采样会把滚动后的位置当成搜索开始前的视口。
 */
function captureSession(
  globals: BrowserGlobals,
  model: ChatFindModelLike,
  widget: WebElement | null,
  scroll: WebElement,
): FindSession {
  const viewport = scroll.getBoundingClientRect();
  const clearance = widget ? widget.getBoundingClientRect().height + 8 : 0;
  const clearTop = viewport.top + clearance;
  const cursor = visibleRowCursor(scroll, model.items);
  return {
    widget,
    scroll,
    seq: cursor?.seq ?? null,
    beforeSeq: cursor ? seqBefore(model.items, cursor.seq, cursor.epoch) : null,
    viewportTop: viewport.top,
    viewportBottom: viewport.bottom,
    clearTop,
    scrollTop: scroll.scrollTop,
    anchors: viewAnchors(globals, scroll, viewport, clearTop),
    generation: 0,
  };
}

function anchorRange(
  globals: BrowserGlobals,
  position: WebCaretPosition,
): WebRange | null {
  const range = globals.document?.createRange?.();
  if (!range) return null;
  try {
    range.setStart(position.offsetNode, position.offset);
    range.collapse(true);
    return range;
  } catch {
    return null;
  }
}

/**
 * 锚点存的是文本节点。虚拟列表把那一行卸载后，节点脱离文档，Range 比较会
 * 抛 WrongDocumentError，只能退回坐标判断。
 */
function anchorsConnected(anchors: ViewAnchors | null): anchors is ViewAnchors {
  if (!anchors) return false;
  return (
    anchors.top.offsetNode.isConnected !== false &&
    anchors.bottom.offsetNode.isConnected !== false
  );
}

function matchAboveAnchors(
  globals: BrowserGlobals,
  anchors: ViewAnchors,
  range: WebRange,
): boolean {
  const top = anchorRange(globals, anchors.top);
  if (!top) return false;
  try {
    // END_TO_START 比较的是 top 锚点起点与匹配终点：锚点在匹配终点之后，
    // 匹配才完全在上方。START_TO_END 只比较起点，会跳过跨过视口上沿的匹配。
    if (!(top.compareBoundaryPoints(RANGE_END_TO_START, range) > 0)) return false;
    // 锚点取在视口顶部水平方向的中点。同一行里位于锚点左侧的匹配在文档
    // 顺序上早于锚点，但视觉上仍在视口内，用行框再确认一次。
    const rangeRect = range.getBoundingClientRect();
    const anchorRect = top.getBoundingClientRect();
    return !(anchorRect.height > 0 && rangeRect.bottom > anchorRect.top + 1);
  } catch {
    return false;
  }
}

function matchOverlapsAnchors(
  globals: BrowserGlobals,
  anchors: ViewAnchors,
  range: WebRange,
): boolean {
  const top = anchorRange(globals, anchors.top);
  const bottom = anchorRange(globals, anchors.bottom);
  if (!top || !bottom) return false;
  try {
    const above = top.compareBoundaryPoints(RANGE_END_TO_START, range) > 0;
    const below = bottom.compareBoundaryPoints(RANGE_START_TO_START, range) < 0;
    return !above && !below;
  } catch {
    return false;
  }
}

function abortCurrentMatch(model: ChatFindModelLike): void {
  // ChatFindModel 的 abort 是私有字段，运行时仍是普通属性；它的 signal
  // 同时控制 reveal 之后的滚动 settle。恢复 scrollTop 前先中止动画。
  // Paseo 自己的 cancel() 中止后还会换一个新的 controller；这里也必须换，
  // 否则 updateHistory 的 fail() 会一直跳过，historyChanged 错误不再上报。
  const record = model as unknown as Record<PropertyKey, unknown>;
  const controller = record.abort;
  if (isRecord(controller) && typeof controller.abort === "function") {
    controller.abort();
    record.abort = new AbortController();
  }
}

function restoreScroll(
  model: ChatFindModelLike,
  scroll: WebElement,
  scrollTop: number,
): void {
  abortCurrentMatch(model);
  scroll.scrollTop = scrollTop;
}

/**
 * Paseo 的 reveal 会把选中匹配滚到查找栏下方。如果匹配本来就在视口里，
 * 初始定位不需要这段滚动：中止后续 settle 动画，恢复搜索开始前的滚动位置。
 * 恢复前必须先解冻，否则写入会被冻结吞掉，页面停在上一轮查询的位置。
 */
function keepVisibleMatch(
  globals: BrowserGlobals,
  model: ChatFindModelLike,
  scroll: WebElement,
  scrollTop: number,
  anchors: ViewAnchors | null,
  releaseLock: () => void,
): boolean {
  if (!anchorsConnected(anchors)) return false;
  const range = selectedMatchRange(globals, scroll);
  if (!range || !matchOverlapsAnchors(globals, anchors, range)) return false;
  releaseLock();
  restoreScroll(model, scroll, scrollTop);
  return true;
}

function waitForModelReady(
  model: ChatFindModelLike,
  query: string,
  previous: ChatFindSnapshot,
): Promise<boolean> {
  const getSnapshot = model.getSnapshot;
  const subscribe = model.subscribe;
  if (!getSnapshot || !subscribe) return Promise.resolve(false);

  return new Promise((resolve) => {
    let settled = false;
    const cleanup: {
      timer?: ReturnType<typeof setTimeout>;
      unsubscribe?: () => void;
    } = {};
    const finish = (ready: boolean): void => {
      if (settled) return;
      settled = true;
      if (cleanup.timer !== undefined) clearTimeout(cleanup.timer);
      cleanup.unsubscribe?.();
      resolve(ready);
    };
    const check = (): void => {
      const state = getSnapshot();
      if (state.query !== query) {
        finish(false);
        return;
      }
      if (
        state.phase === "ready" &&
        (state.occurrence !== previous.occurrence ||
          state.selectedItemId !== previous.selectedItemId)
      ) {
        finish(true);
        return;
      }
      if (state.phase === "error" || state.phase === "idle") finish(false);
    };
    cleanup.unsubscribe = subscribe(check);
    cleanup.timer = setTimeout(() => finish(false), 5000);
    check();
  });
}

/**
 * 一个长消息会跨过整个视口。Paseo 的初始选中总是消息里的第一条匹配，因此
 * 视口停在消息中段时，选中点可能在视口上方，查找会把页面向上拽很远。
 *
 * 这里以搜索开始前保存的视口锚点为基准，按 Paseo 自己的 next 步进，直到选中
 * 点不再完全位于原视口上方。目标消息已经挂载时初始定位期间滚动是冻结的，
 * 因此最终选中点本来就在原视口里时页面完全没有动过。
 */
async function alignInitialMatch(
  globals: BrowserGlobals,
  model: ChatFindModelLike,
  scroll: WebElement,
  viewportTop: number,
  viewportBottom: number,
  clearTop: number,
  scrollTop: number,
  anchors: ViewAnchors | null,
  shouldContinue: () => boolean,
  releaseLock: () => void,
): Promise<boolean> {
  const getSnapshot = model.getSnapshot;
  const next = model.next;
  if (!getSnapshot || !next) return false;

  const initial = getSnapshot();
  const query = initial.query;
  const threshold = viewportTop + scrollTop;
  const seen = new Set<string>();
  // 锚点节点可能已被虚拟列表卸载，这时退回文档坐标判断。
  const liveAnchors = anchorsConnected(anchors) ? anchors : null;
  // 后面的消息渲染后可能没有匹配，navigate 会取模回到前面的消息；seen 和
  // 步数上限用来在这种情况下停止。不能用固定上限，长消息里视口上方可能
  // 超过 200 条匹配。
  const maxSteps = initial.count + 1;

  for (let step = 0; step < maxSteps; step += 1) {
    if (!shouldContinue()) return false;
    const state = getSnapshot();
    if (state.query !== query || state.phase !== "ready") return false;
    const key = `${state.selectedItemId}:${state.occurrence}`;
    if (seen.has(key)) return false;
    seen.add(key);

    const range = selectedMatchRange(globals, scroll);
    if (!range) return false;

    // 有锚点时按文档顺序比较；浏览器没有提供锚点 API 时退回文档坐标。
    let above: boolean;
    if (liveAnchors) {
      above = matchAboveAnchors(globals, liveAnchors, range);
    } else {
      const rect = range.getBoundingClientRect();
      above = rect.bottom + scroll.scrollTop <= threshold;
    }

    if (!above) {
      // 匹配落在原视口里：保留原滚动位置，不要再为了把匹配滚到查找栏下方滚一次。
      if (liveAnchors && matchOverlapsAnchors(globals, liveAnchors, range)) {
        releaseLock();
        restoreScroll(model, scroll, scrollTop);
        return true;
      }
      if (!liveAnchors) {
        const rect = range.getBoundingClientRect();
        // 滚动后 rect 已经偏移，加回 delta 才是搜索开始前的视口坐标。
        const delta = scroll.scrollTop - scrollTop;
        const originalTop = rect.top + delta;
        const originalBottom = rect.bottom + delta;
        if (originalTop >= clearTop && originalBottom <= viewportBottom) {
          releaseLock();
          restoreScroll(model, scroll, scrollTop);
          return true;
        }
      }
      return false;
    }

    // 下方没有更多匹配时停在最后一条，也就是离原视口最近的先前匹配，
    // 不再绕回整个会话的第一条。
    if (state.occurrence >= state.count - 1) return false;

    const savedLocation = currentLocation(model);
    // 下一步会跳到另一条消息时先解冻，让 Paseo 能滚动挂载它。
    if (nextLeavesMessage(model)) releaseLock();
    next();
    if (!(await waitForModelReady(model, query, state))) return false;

    // 后面的 location 可能渲染后没有任何匹配，Paseo 会丢弃它并取模回绕到
    // 前面的消息。检测到选中位置倒退就退回步进前的那条消息，停在最近的上方匹配。
    const movedTo = currentLocation(model);
    if (savedLocation && movedTo) {
      const from = model.locations.indexOf(savedLocation);
      const to = model.locations.indexOf(movedTo);
      if (from >= 0 && to >= 0 && to < from) {
        try {
          await model.navigate(from, -1, new AbortController().signal);
        } catch (error) {
          warnOnce(error);
        }
        return false;
      }
    }
  }
  return false;
}

function patchModel(
  model: ChatFindModelLike,
  widget: WebElement,
  globals: BrowserGlobals,
): void {
  const root = rootOfWidget(widget);
  if (!root) return;
  // 模型可能已经 patch 过，但 root 可能换过；先更新 root 再决定是否包装。
  MODEL_ROOTS.set(model, root);
  if (PATCH_INFO.has(model)) return;
  if ((model as unknown as Record<PropertyKey, unknown>)[PATCHED]) return;

  const original = model.navigate;
  const patched = function (
    this: unknown,
    ...args: unknown[]
  ): Promise<unknown> {
    // 插件正在卸载时不再做额外处理，只保留原生查找。
    if (!ACTIVE) return original.apply(model, args);
    // 只拦 search() 在结果就绪后的初始 navigate(0, 1)。上一个/下一个和
    // 其他索引都原样放行。
    if (args.length < 3 || args[0] !== 0 || args[1] !== 1) {
      return original.apply(model, args);
    }

    const signal = args[2];
    const context = (() => {
      try {
        const currentRoot = MODEL_ROOTS.get(model);
        const scroll = currentRoot ? scrollOfRoot(currentRoot) : null;
        if (!scroll) return null;
        const widget = currentRoot ? currentRoot.querySelector(WIDGET_SELECTOR) : null;
        const existing = SESSIONS.get(model);
        let session: FindSession;
        // 正常路径在 setQuery 时已经采样；这里补上浮层刚挂载的情况。
        if (existing && existing.widget === widget && existing.scroll === scroll) {
          session = existing;
        } else {
          session = captureSession(globals, model, widget, scroll);
          SESSIONS.set(model, session);
        }
        const target = targetIndex(model, scroll, session.seq, session.beforeSeq);
        if (target === null) return null;
        // 快速输入时上一个字符的定位可能还没结束；只让最新一次 navigate 执行定位。
        session.generation += 1;
        // 目标消息已经渲染时冻结滚动，避免 Paseo 把消息顶部拽到查找栏下方
        // 再被恢复，用户会看到一次来回滚动。
        const lock = targetMessageMounted(model, scroll, target.index)
          ? lockScroll(scroll)
          : null;
        return {
          target: target.index,
          direction: target.direction,
          scroll,
          session,
          generation: session.generation,
          lock,
        };
      } catch (error) {
        warnOnce(error);
        return null;
      }
    })();
    if (!context) return original.apply(model, args);

    // next() 会 cancel 当前搜索的 signal，所以 signal.aborted 只能用来拦住
    // 尚未开始的旧搜索；定位循环里的取消交给 phase 和 generation 判断。
    const shouldContinue = (): boolean =>
      ACTIVE && context.session.generation === context.generation;

    const result = original.apply(model, [
      context.target,
      context.direction,
      ...args.slice(2),
    ]);
    // 同一消息内的匹配可能还在原视口上方，等 Paseo 完成第一次 reveal 后再定位。
    return Promise.resolve(result).then(async (value) => {
      try {
        // 查询已经取消或已有更新的一次搜索时，旧结果不再参与定位，
        // 否则旧结果会覆盖新搜索的选中项和滚动位置。
        if (!shouldContinue() || isAborted(signal)) return value;
        const kept = keepVisibleMatch(
          globals,
          model,
          context.scroll,
          context.session.scrollTop,
          context.session.anchors,
          () => context.lock?.release(),
        );
        if (!kept) {
          const visible = await alignInitialMatch(
            globals,
            model,
            context.scroll,
            context.session.viewportTop,
            context.session.viewportBottom,
            context.session.clearTop,
            context.session.scrollTop,
            context.session.anchors,
            shouldContinue,
            () => context.lock?.release(),
          );
          // 冻结期间页面没动过；最终匹配不在原视口时只滚这一次。
          if (!visible && context.lock?.active && shouldContinue()) {
            // 先中止动画并解冻，再按真实位置计算落点；冻结中的 scrollTop
            // 读数是加锁时的快照，用户滚动过就会算错。
            abortCurrentMatch(model);
            context.lock.release();
            const targetTop = selectedMatchScrollTop(globals, context.scroll, context.session);
            if (targetTop !== null) {
              context.scroll.scrollTop = targetTop;
            }
          }
        }
      } catch (error) {
        warnOnce(error);
      }
      return value;
    }).finally(() => {
      // navigate 失败或抛错时也要解冻，否则滚动会一直被冻结。
      context.lock?.release();
    });
  };

  const originalSetQuery = model.setQuery;
  const patchedSetQuery = function (
    this: unknown,
    ...args: unknown[]
  ): unknown {
    try {
      // 在查询发出前采样视口；搜索返回前用户可能已经滚动。
      if (ACTIVE) {
        const currentRoot = MODEL_ROOTS.get(model);
        const scroll = currentRoot ? scrollOfRoot(currentRoot) : null;
        const widget = currentRoot ? currentRoot.querySelector(WIDGET_SELECTOR) : null;
        const query = args[0];
        if (scroll && widget) {
          if (typeof query === "string" && query.trim() === "") {
            SESSIONS.delete(model);
          } else {
            const existing = SESSIONS.get(model);
            if (!existing || existing.widget !== widget || existing.scroll !== scroll) {
              SESSIONS.set(model, captureSession(globals, model, widget, scroll));
            }
          }
        }
      }
    } catch (error) {
      warnOnce(error);
    }
    return originalSetQuery.apply(model, args);
  };

  try {
    if (!Object.isExtensible(model)) {
      warnOnce(new Error("ChatFindModel is not extensible"));
      return;
    }
    Object.defineProperty(model, "navigate", {
      configurable: true,
      enumerable: false,
      writable: true,
      value: patched,
    });
    try {
      Object.defineProperty(model, "setQuery", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: patchedSetQuery,
      });
    } catch (error) {
      // 只包装了一半时恢复 navigate，避免留下无法清理的状态。
      Object.defineProperty(model, "navigate", {
        configurable: true,
        enumerable: false,
        writable: true,
        value: original,
      });
      throw error;
    }
    (model as unknown as Record<PropertyKey, unknown>)[PATCHED] = true;
    // 查找面板第一次渲染时就把原始的 setQuery 交给了 onQueryChange，要等
    // 下一次渲染才会换成包装后的方法。第一个字符因此不经过包装，订阅
    // "searching" 状态在查询发出时补采视口，避免搜索期间滚动后采到新位置。
    let unsubscribe: (() => void) | undefined;
    if (model.subscribe) {
      try {
        unsubscribe = model.subscribe(() => {
          if (!ACTIVE) return;
          try {
            const snapshot = model.getSnapshot?.();
            if (!snapshot || snapshot.phase !== "searching") return;
            const root = MODEL_ROOTS.get(model);
            const scroll = root ? scrollOfRoot(root) : null;
            const widget = root ? root.querySelector(WIDGET_SELECTOR) : null;
            if (!scroll || !widget) return;
            const existing = SESSIONS.get(model);
            if (existing && existing.widget === widget && existing.scroll === scroll) {
              return;
            }
            SESSIONS.set(model, captureSession(globals, model, widget, scroll));
          } catch (error) {
            warnOnce(error);
          }
        });
      } catch (error) {
        warnOnce(error);
      }
    }
    PATCH_INFO.set(model, {
      originalNavigate: original,
      patchedNavigate: patched,
      originalSetQuery,
      patchedSetQuery,
      unsubscribe,
    });
    PATCHED_MODELS.add(new WeakRef(model));
  } catch (error) {
    warnOnce(error);
  }
}

/**
 * 插件卸载或 reload 后，已打开的聊天仍然持有 model。把被替换的方法换回去，
 * 并清除标记，让下一次安装能重新包装。
 */
function restorePatchedModels(): void {
  for (const ref of PATCHED_MODELS) {
    const model = ref.deref();
    if (!model) continue;
    const patch = PATCH_INFO.get(model);
    if (!patch) continue;
    try {
      patch.unsubscribe?.();
      if (model.navigate === patch.patchedNavigate) {
        Object.defineProperty(model, "navigate", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: patch.originalNavigate,
        });
      }
      if (model.setQuery === patch.patchedSetQuery) {
        Object.defineProperty(model, "setQuery", {
          configurable: true,
          enumerable: false,
          writable: true,
          value: patch.originalSetQuery,
        });
      }
      delete (model as unknown as Record<PropertyKey, unknown>)[PATCHED];
    } catch (error) {
      warnOnce(error);
    }
    // 同一模块实例重新安装时可以重新包装，不沿用旧的锚点。
    PATCH_INFO.delete(model);
    SESSIONS.delete(model);
  }
  PATCHED_MODELS.clear();
}

export function installChatFindFromView(): () => void {
  const globals = globalThis as unknown as BrowserGlobals;
  const document = globals.document;
  if (!document?.body) return () => {};

  const Observer = globals.MutationObserver;
  if (!Observer) return () => {};

  let timer: ReturnType<typeof setTimeout> | undefined;
  const probe = (): void => {
    try {
      const widgets = document.querySelectorAll(WIDGET_SELECTOR);
      for (let index = 0; index < widgets.length; index += 1) {
        const widget = widgets[index];
        if (!widget) continue;
        try {
          const model = modelFromWidget(widget);
          if (model) patchModel(model, widget, globals);
        } catch (error) {
          warnOnce(error);
        }
      }
    } catch (error) {
      warnOnce(error);
    }
  };
  const schedule = (records: WebMutationRecord[]): void => {
    if (timer !== undefined) return;
    // 流式输出会产生大量时间线变更；只有新增节点里带查找浮层时才探测，
    // 避免在消息更新时反复走 React fiber。
    let found = false;
    for (const record of records) {
      const nodes = record.addedNodes;
      for (let index = 0; index < nodes.length; index += 1) {
        const node = nodes[index];
        if (node && containsWidget(node)) {
          found = true;
          break;
        }
      }
      if (found) break;
    }
    if (!found) return;
    timer = setTimeout(() => {
      timer = undefined;
      probe();
    }, 0);
  };

  let observer: WebMutationObserver;
  try {
    observer = new Observer(schedule);
    observer.observe(document.body, { childList: true, subtree: true });
  } catch (error) {
    warnOnce(error);
    return () => {};
  }
  // 插件安装时浮层可能已经打开
  ACTIVE = true;
  probe();

  return () => {
    ACTIVE = false;
    observer.disconnect();
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    for (const lock of [...SCROLL_LOCKS]) lock.release();
    restorePatchedModels();
  };
}
