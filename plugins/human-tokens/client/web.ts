import { Platform } from "react-native";
import { notePaste } from "./activity";
import type { ScanRow } from "./model";

/**
 * web 端通过 host 页面里的 DOM 读取时间线的真实位置。
 *
 * Paseo 没有公开的时间线可见性 API；这里依赖 host web bundle 的稳定标记：
 * - [data-testid="assistant-message"]：AssistantMessage 的 host View
 * - [data-testid="agent-chat-scroll"]：滚动视口
 * - [data-message-id]：时间线行，作为 occurrenceKey 缺失时的 fallback
 *
 * 消息正文和 occurrenceKey 从 AssistantMessage 的 React fiber props 读取，
 * 不从 DOM 文本拼，避免把按钮、行号等 UI 文本算进去。
 */

interface WebRect {
  top: number;
  bottom: number;
  left: number;
  right: number;
  width: number;
  height: number;
}

interface WebElement {
  [key: string]: unknown;
  getBoundingClientRect(): WebRect;
  getClientRects(): ArrayLike<unknown>;
  closest(selector: string): WebElement | null;
  getAttribute(name: string): string | null;
  checkVisibility?(options?: {
    opacityProperty?: boolean;
    visibilityProperty?: boolean;
  }): boolean;
}

interface WebElementList {
  readonly length: number;
  [index: number]: WebElement;
}

interface WebPasteEvent {
  readonly target: unknown;
  readonly clipboardData: { getData(type: string): string } | null;
}

interface WebWheelEvent {
  readonly deltaY: number;
  /** DOM_DELTA_PIXEL=0、DOM_DELTA_LINE=1、DOM_DELTA_PAGE=2 */
  readonly deltaMode: number;
  readonly clientX: number;
  preventDefault(): void;
}

interface WebWheelElement extends WebElement {
  addEventListener(
    type: "wheel",
    listener: (event: WebWheelEvent) => void,
    options?: { passive?: boolean },
  ): void;
  removeEventListener(
    type: "wheel",
    listener: (event: WebWheelEvent) => void,
  ): void;
}

interface WebKeyboardEvent {
  readonly key: string;
  preventDefault(): void;
}

interface WebKeyboardElement extends WebElement {
  addEventListener(
    type: "keydown",
    listener: (event: WebKeyboardEvent) => void,
  ): void;
  removeEventListener(
    type: "keydown",
    listener: (event: WebKeyboardEvent) => void,
  ): void;
}

interface WebDocument {
  readonly visibilityState: string;
  readonly location: { href: string };
  hasFocus(): boolean;
  querySelectorAll(selector: string): WebElementList;
  addEventListener(
    type: "paste",
    listener: (event: WebPasteEvent) => void,
    capture?: boolean,
  ): void;
  removeEventListener(
    type: "paste",
    listener: (event: WebPasteEvent) => void,
    capture?: boolean,
  ): void;
}

declare const document: WebDocument;

/** host 的 assistant 消息渲染上限，来自 Paseo 的 assistant-message-render-limit.web.ts */
const RENDER_CHARACTER_LIMIT = 32_000;
const graphemeSegmenter =
  typeof Intl.Segmenter === "function"
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

function capForRender(message: string): string {
  if (message.length <= RENDER_CHARACTER_LIMIT) return message;
  let end = RENDER_CHARACTER_LIMIT;
  if (graphemeSegmenter) {
    end = graphemeSegmenter.segment(message).containing(end)!.index;
  } else {
    const finalCodeUnit = message.charCodeAt(end - 1);
    if (finalCodeUnit >= 0xd800 && finalCodeUnit <= 0xdbff) end -= 1;
  }
  return message.slice(0, end);
}

interface FiberNode {
  return: FiberNode | null;
  child: FiberNode | null;
  sibling: FiberNode | null;
  /** 上一次提交的 fiber；DOM 节点上的指针可能指向旧树 */
  alternate?: FiberNode | null;
  /** HostRoot fiber 的 stateNode 是 FiberRoot，current 指向当前树 */
  stateNode?: unknown;
  memoizedProps: Record<string, unknown> | null;
}

function fiberFromNode(node: WebElement): FiberNode | null {
  const key = Object.keys(node).find((candidate) =>
    candidate.startsWith("__reactFiber$"),
  );
  if (!key) return null;
  const value = node[key];
  return value && typeof value === "object" ? (value as FiberNode) : null;
}

function topFiber(fiber: FiberNode): FiberNode {
  let node = fiber;
  let guard = 0;
  while (node.return && guard < 200) {
    node = node.return;
    guard += 1;
  }
  return node;
}

function isCurrentFiber(fiber: FiberNode): boolean {
  const top = topFiber(fiber);
  const root = top.stateNode as { current?: FiberNode | null } | null | undefined;
  return root?.current === top;
}

/**
 * DOM 节点上的 __reactFiber$ 在 commit 后不一定指向当前树。
 * 先看指针本身，不是当前树时换到它的 alternate 再读 props。
 */
function resolveCurrentFiber(fiber: FiberNode): FiberNode {
  if (isCurrentFiber(fiber)) return fiber;
  const alternate = fiber.alternate;
  if (alternate && isCurrentFiber(alternate)) return alternate;
  return fiber;
}

function readAssistantProps(node: WebElement): Record<string, unknown> | null {
  const pointer = fiberFromNode(node);
  let fiber = pointer ? resolveCurrentFiber(pointer) : null;
  let depth = 0;
  while (fiber && depth < 60) {
    const props = fiber.memoizedProps;
    if (
      props &&
      typeof props.message === "string" &&
      (typeof props.occurrenceKey === "string" || typeof props.phase === "string")
    ) {
      return props;
    }
    fiber = fiber.return;
    depth += 1;
  }
  return null;
}

function elementVisible(node: WebElement): boolean {
  if (typeof node.checkVisibility === "function") {
    try {
      if (
        !node.checkVisibility({
          opacityProperty: true,
          visibilityProperty: true,
        })
      ) {
        return false;
      }
    } catch {
      // 旧浏览器不支持 options 时回退到 rect 判断
    }
  }
  const rect = node.getBoundingClientRect();
  if (!(rect.width > 0) || !(rect.height > 0)) return false;
  if (node.getClientRects().length === 0) return false;
  // Paseo 自己的文本提取也用 aria-hidden 排除不可见分支
  if (node.closest('[aria-hidden="true"]')) return false;
  return true;
}

function scanWeb(): ScanRow[] {
  if (Platform.OS !== "web") return [];
  const nodes = document.querySelectorAll('[data-testid="assistant-message"]');
  const rows: ScanRow[] = [];

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!node || !elementVisible(node)) continue;
    const viewport = node.closest('[data-testid="agent-chat-scroll"]');
    if (!viewport || !elementVisible(viewport)) continue;

    const props = readAssistantProps(node);
    if (
      !props ||
      props.phase !== "complete" ||
      typeof props.message !== "string"
    ) {
      continue;
    }
    const text =
      props.renderFullContent === true
        ? props.message
        : capForRender(props.message);

    const rect = node.getBoundingClientRect();
    const viewportRect = viewport.getBoundingClientRect();
    if (rect.height <= 0 || viewportRect.height <= 0) continue;

    const occurrence =
      typeof props.occurrenceKey === "string" ? props.occurrenceKey : null;
    let agentId: string | null = null;
    let messageId: string | null = null;
    let key: string | null = null;

    if (occurrence) {
      // occurrenceKey = `${agentId}:${itemId}`；agentId 是 UUID，不含冒号。
      // itemId 只在 agent 内唯一，所以消息身份必须用完整的 occurrenceKey。
      const separator = occurrence.indexOf(":");
      if (separator > 0 && separator < occurrence.length - 1) {
        agentId = occurrence.slice(0, separator);
        messageId = occurrence;
        key = occurrence;
      }
    }

    if (!messageId || !key) {
      const row = node.closest("[data-message-id]");
      const fallbackId = row?.getAttribute("data-message-id") ?? null;
      if (!fallbackId) continue;
      messageId = `web:${fallbackId}`;
      key = messageId;
    }

    rows.push({
      key,
      messageId,
      agentId,
      text,
      top: rect.top,
      bottom: rect.bottom,
      viewportTop: viewportRect.top,
      viewportBottom: viewportRect.bottom,
      visible: true,
    });
  }

  return rows;
}

export function createWebScanner(): () => ScanRow[] {
  return scanWeb;
}

export function webIsForeground(): boolean {
  if (Platform.OS !== "web") return false;
  // 同一设备开多个窗口时只有聚焦窗口计时，避免活动时间翻倍
  return document.visibilityState === "visible" && document.hasFocus();
}

/**
 * React Native Web 的 View 没有 onWheel，直接在 DOM 节点上监听。
 * 必须 passive: false，否则 preventDefault 无法阻止页面滚动。
 * handler 返回是否消费了这次滚轮；到达缩放边界时返回 false，放行页面滚动。
 * native 返回 no-op，缩放按钮仍然可用。
 */
export function addWheelZoom(
  node: unknown,
  handler: (deltaY: number, offsetX: number) => boolean,
): () => void {
  if (Platform.OS !== "web" || !node) return () => {};
  const element = node as WebWheelElement;
  if (
    typeof element.addEventListener !== "function" ||
    typeof element.removeEventListener !== "function" ||
    typeof element.getBoundingClientRect !== "function"
  ) {
    return () => {};
  }
  const listener = (event: WebWheelEvent): void => {
    // Firefox 可能按行或按页给 deltaY；先换算成像素，统一后面的累积阈值
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 400 : 1;
    const deltaY = event.deltaY * unit;
    if (deltaY === 0) return;
    const handled = handler(
      deltaY,
      event.clientX - element.getBoundingClientRect().left,
    );
    if (handled) event.preventDefault();
  };
  element.addEventListener("wheel", listener, { passive: false });
  return () => element.removeEventListener("wheel", listener);
}

/**
 * web 的键盘选择：滑块聚焦后左右方向键切换 5 分钟。
 * native 走 accessibilityActions，不需要这个监听。
 */
export function addKeySelect(
  node: unknown,
  handler: (delta: number) => boolean,
): () => void {
  if (Platform.OS !== "web" || !node) return () => {};
  const element = node as WebKeyboardElement;
  if (
    typeof element.addEventListener !== "function" ||
    typeof element.removeEventListener !== "function"
  ) {
    return () => {};
  }
  const listener = (event: WebKeyboardEvent): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    const handled = handler(event.key === "ArrowRight" ? 1 : -1);
    if (handled) event.preventDefault();
  };
  element.addEventListener("keydown", listener);
  return () => element.removeEventListener("keydown", listener);
}

/** 只在 web 安装；native 返回 no-op，由输入增量阈值兜底 */
export function installPasteListener(): () => void {
  if (Platform.OS !== "web") return () => {};

  const handler = (event: WebPasteEvent): void => {
    const target = event.target;
    if (!target || typeof target !== "object") return;
    const element = target as WebElement;
    if (typeof element.closest !== "function") return;
    // 只认 composer 输入区，避免把别处的粘贴当成输入
    const editable = element.closest('textarea,[contenteditable="true"]');
    if (!editable) return;
    const text = event.clipboardData?.getData("text/plain") ?? "";
    if (!text) return;
    notePaste(Array.from(text).length);
  };

  document.addEventListener("paste", handler, true);
  return () => document.removeEventListener("paste", handler, true);
}
