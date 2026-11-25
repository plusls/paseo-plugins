import {
  Dimensions,
  Platform,
  StyleSheet,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import type { ScanRow } from "./model";

/**
 * native 端从 React fiber 树读取 assistant 消息和它的 Fabric host 位置。
 *
 * Paseo 没有公开的时间线可见性 API；这里依赖 host 在 Android/iOS 上的实现细节：
 * - host View 带 testID="assistant-message"
 * - AssistantMessage 组件的 props 里有 occurrenceKey / message / phase
 * - 滚动视口带 testID="agent-chat-scroll" 或 nativeID="agent-chat-scroll-native-virtualized"
 * - Fabric host instance 有 unstable_getBoundingClientRect()
 *
 * 这是内部 API，Paseo 升级后可能失效；失效时不会乱记，只会没有数据并打一条 warn。
 */

interface FiberNode {
  return: FiberNode | null;
  child: FiberNode | null;
  sibling: FiberNode | null;
  memoizedProps: Record<string, unknown> | null;
  stateNode: unknown;
}

interface NativeRect {
  top: number;
  bottom: number;
}

interface RawRect {
  top?: number;
  bottom?: number;
  y?: number;
  height?: number;
}

interface NativeHostInstance {
  unstable_getBoundingClientRect?: () => RawRect | null | undefined;
  getBoundingClientRect?: () => RawRect | null | undefined;
}

const SCROLL_TEST_ID = "agent-chat-scroll";
const SCROLL_NATIVE_ID = "agent-chat-scroll-native-virtualized";

let lastWarnAt = 0;

function warnUnsupported(message: string): void {
  const now = Date.now();
  if (now - lastWarnAt < 60_000) return;
  lastWarnAt = now;
  console.warn(`[human-tokens] ${message}`);
}

function isFiber(value: unknown): value is FiberNode {
  return (
    value !== null &&
    typeof value === "object" &&
    "return" in value &&
    "child" in value &&
    "sibling" in value
  );
}

function rootFiber(ref: unknown): FiberNode | null {
  if (!ref || typeof ref !== "object") return null;
  const candidates: unknown[] = [ref];
  const canonical = (ref as { canonical?: { publicInstance?: unknown } })
    .canonical?.publicInstance;
  if (canonical) candidates.push(canonical);

  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const handle = (candidate as { __internalInstanceHandle?: unknown })
      .__internalInstanceHandle;
    if (!isFiber(handle)) continue;
    let fiber = handle;
    let guard = 0;
    while (fiber.return && guard < 200) {
      fiber = fiber.return;
      guard += 1;
    }
    // HostRoot 的 stateNode 是 FiberRoot；隐藏 View 的 fiber 可能来自旧树，
    // 从 current 开始遍历才能读到本轮 commit 之后的 props
    const root = fiber.stateNode;
    if (root && typeof root === "object") {
      const current = (root as { current?: unknown }).current;
      if (isFiber(current)) return current;
    }
    return fiber;
  }
  return null;
}

function isMeasurable(host: NativeHostInstance): boolean {
  return (
    typeof host.unstable_getBoundingClientRect === "function" ||
    typeof host.getBoundingClientRect === "function"
  );
}

function hostInstance(fiber: FiberNode): NativeHostInstance | null {
  const state = fiber.stateNode;
  if (!state || typeof state !== "object") return null;
  const canonical = (state as { canonical?: { publicInstance?: unknown } })
    .canonical?.publicInstance;
  if (canonical && typeof canonical === "object") {
    const host = canonical as NativeHostInstance;
    if (isMeasurable(host)) return host;
  }
  const direct = state as NativeHostInstance;
  if (isMeasurable(direct)) return direct;
  return null;
}

function rectOf(host: NativeHostInstance): NativeRect | null {
  const measure =
    host.unstable_getBoundingClientRect ?? host.getBoundingClientRect;
  if (typeof measure !== "function") return null;
  try {
    const raw = measure.call(host);
    if (!raw) return null;
    const top = typeof raw.top === "number" ? raw.top : raw.y;
    const bottom =
      typeof raw.bottom === "number"
        ? raw.bottom
        : typeof raw.y === "number" && typeof raw.height === "number"
          ? raw.y + raw.height
          : undefined;
    if (
      typeof top !== "number" ||
      typeof bottom !== "number" ||
      !Number.isFinite(top) ||
      !Number.isFinite(bottom) ||
      bottom <= top
    ) {
      return null;
    }
    return { top, bottom };
  } catch {
    return null;
  }
}

function readAssistantProps(
  fiber: FiberNode,
): Record<string, unknown> | null {
  let current: FiberNode | null = fiber;
  let depth = 0;
  while (current && depth < 80) {
    const props = current.memoizedProps;
    if (
      props &&
      typeof props.message === "string" &&
      (typeof props.occurrenceKey === "string" || typeof props.phase === "string")
    ) {
      return props;
    }
    current = current.return;
    depth += 1;
  }
  return null;
}

function flattenStyle(style: unknown): ViewStyle | null {
  if (style === null || style === undefined) return null;
  try {
    const flat = StyleSheet.flatten(style as StyleProp<ViewStyle>);
    return (flat ?? null) as ViewStyle | null;
  } catch {
    return null;
  }
}

function isHiddenFiber(fiber: FiberNode): boolean {
  let current: FiberNode | null = fiber;
  let depth = 0;
  while (current && depth < 80) {
    const props = current.memoizedProps;
    if (props) {
      if (props.accessibilityElementsHidden === true) return true;
      if (props.importantForAccessibility === "no-hide-descendants") return true;
      const style = flattenStyle(props.style);
      if (style) {
        if (style.display === "none") return true;
        if (style.opacity === 0) return true;
      }
    }
    current = current.return;
    depth += 1;
  }
  return false;
}

function isScrollFiber(fiber: FiberNode): boolean {
  const style = flattenStyle(fiber.memoizedProps?.style);
  if (!style) return false;
  const record = style as unknown as Record<string, unknown>;
  return (
    record.overflow === "scroll" ||
    record.overflow === "auto" ||
    record.overflowY === "scroll" ||
    record.overflowY === "auto"
  );
}

function hasScrollMarker(props: Record<string, unknown> | null): boolean {
  if (!props) return false;
  return props.testID === SCROLL_TEST_ID || props.nativeID === SCROLL_NATIVE_ID;
}

function findViewportMarker(fiber: FiberNode): FiberNode | null {
  let current: FiberNode | null = fiber;
  let depth = 0;
  while (current && depth < 80) {
    if (hasScrollMarker(current.memoizedProps)) return current;
    current = current.return;
    depth += 1;
  }
  return null;
}

/**
 * 从 marker 子树里找滚动视口的 host。
 * marker 本身可能是 LegendList 之类的组合组件，没有 host instance；
 * 优先返回带 marker 的 host，其次带滚动样式的 host，最后第一个有 rect 的 host。
 */
function findViewportRect(marker: FiberNode): NativeRect | null {
  const markerHost = hostInstance(marker);
  if (markerHost) {
    const rect = rectOf(markerHost);
    if (rect) return rect;
  }

  const stack: FiberNode[] = [];
  if (marker.child) stack.push(marker.child);
  let firstRect: NativeRect | null = null;
  let scrollRect: NativeRect | null = null;
  let visited = 0;

  while (stack.length > 0 && visited < 2_000) {
    const node = stack.pop();
    if (!node) break;
    visited += 1;
    const props = node.memoizedProps;
    const host = hostInstance(node);
    if (host) {
      const rect = rectOf(host);
      if (rect) {
        if (hasScrollMarker(props)) return rect;
        if (!scrollRect && isScrollFiber(node)) scrollRect = rect;
        if (!firstRect) firstRect = rect;
      }
    }
    if (node.child) stack.push(node.child);
    if (node.sibling) stack.push(node.sibling);
  }

  return scrollRect ?? firstRect;
}

/** marker 缺失时的兜底：往上找包含这一行的最近滚动祖先 */
function nearestAncestorRect(
  fiber: FiberNode,
  rowRect: NativeRect,
): NativeRect | null {
  let current: FiberNode | null = fiber.return;
  let fallback: NativeRect | null = null;
  let depth = 0;
  while (current && depth < 80) {
    const host = hostInstance(current);
    if (host) {
      const rect = rectOf(host);
      if (
        rect &&
        rect.top <= rowRect.top &&
        rect.bottom >= rowRect.bottom
      ) {
        if (isScrollFiber(current)) return rect;
        if (!fallback) fallback = rect;
      }
    }
    current = current.return;
    depth += 1;
  }
  return fallback;
}

function scanNative(getRoot: () => unknown): ScanRow[] {
  if (Platform.OS === "web") return [];

  const root = rootFiber(getRoot());
  if (!root) return [];

  const window = Dimensions.get("window");
  if (!(window.height > 0)) return [];

  const rows: ScanRow[] = [];
  const viewportCache = new Map<FiberNode, NativeRect | null>();
  const stack: FiberNode[] = [root];
  let visited = 0;
  let candidates = 0;
  let missingIdentity = 0;

  while (stack.length > 0 && visited < 50_000) {
    const fiber = stack.pop();
    if (!fiber) break;
    visited += 1;

    const props = fiber.memoizedProps;
    if (props && props.testID === "assistant-message") {
      const host = hostInstance(fiber);
      if (host) {
        const assistant = readAssistantProps(fiber);
        if (
          assistant &&
          assistant.phase === "complete" &&
          typeof assistant.message === "string"
        ) {
          if (!isHiddenFiber(fiber)) {
            candidates += 1;
            const text = assistant.message;
            const occurrence =
              typeof assistant.occurrenceKey === "string"
                ? assistant.occurrenceKey
                : null;
            let agentId: string | null = null;
            let messageId: string | null = null;
            let key: string | null = null;

            if (occurrence) {
              const separator = occurrence.indexOf(":");
              if (separator > 0 && separator < occurrence.length - 1) {
                agentId = occurrence.slice(0, separator);
                // itemId 只在 agent 内唯一，完整 occurrenceKey 才是全局身份
                messageId = occurrence;
                key = occurrence;
              }
            }

            if (!messageId || !key) {
              missingIdentity += 1;
            } else {
              const rowRect = rectOf(host);
              if (
                rowRect &&
                rowRect.bottom > 0 &&
                rowRect.top < window.height
              ) {
                const marker = findViewportMarker(fiber);
                let viewportRect: NativeRect | null = null;
                if (marker) {
                  if (viewportCache.has(marker)) {
                    viewportRect = viewportCache.get(marker) ?? null;
                  } else {
                    viewportRect = findViewportRect(marker);
                    viewportCache.set(marker, viewportRect);
                  }
                }
                if (!viewportRect) {
                  viewportRect = nearestAncestorRect(fiber, rowRect);
                }
                if (
                  viewportRect &&
                  viewportRect.bottom > 0 &&
                  viewportRect.top < window.height
                ) {
                  rows.push({
                    key,
                    messageId,
                    agentId,
                    text,
                    top: rowRect.top,
                    bottom: rowRect.bottom,
                    viewportTop: viewportRect.top,
                    viewportBottom: viewportRect.bottom,
                    visible: true,
                  });
                }
              }
            }
          }
        }
      }
    }

    if (fiber.child) stack.push(fiber.child);
    if (fiber.sibling) stack.push(fiber.sibling);
  }

  if (candidates > 0 && rows.length === 0) {
    const missing =
      missingIdentity > 0
        ? `，其中 ${missingIdentity} 个缺少 occurrenceKey`
        : "";
    warnUnsupported(
      `找到 ${candidates} 个已完成的 assistant 消息，但读不到可用的窗口位置${missing}`,
    );
  }

  return rows;
}

export function createNativeScanner(
  getRoot: () => unknown,
): () => ScanRow[] {
  return () => scanNative(getRoot);
}
