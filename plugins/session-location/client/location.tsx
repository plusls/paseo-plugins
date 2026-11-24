import type { PaseoAgent } from "@getpaseo/client";
import {
  useSubscription,
  type PluginButtonContentProps,
  type PluginButtonRegistration,
  type PluginClientContext,
  type PluginHostProps,
  type PluginSubscriptionHandle,
} from "@getpaseo/plugin/client";
import { Icon } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Text, View } from "react-native";
import { locationSubscription, type LocationSnapshot } from "../shared/location";

const PILL_ID = "session-location";
// Paseo 给 composer pill 的 maxWidth 是 160px，扣掉图标、chevron、间距和内边距后
// 正文只剩约 90px，约合 12px 字号下的 13 个 ASCII 字符。超过后 Paseo 会从尾部硬截，
// 所以这里先用更小的预算自己截断，保证首尾都能看到。
const PILL_TEXT_UNITS = 13;

// home 目录是路径前缀的启发式判断，不查询真实的用户 home
const POSIX_HOME = /^\/(?:home|Users)\/[^/]+(?=\/|$)/;
const WINDOWS_HOME = /^[A-Za-z]:[\\/]Users[\\/][^\\/]+(?=[\\/]|$)/;
// Paseo 自建 worktree 的目录是 <paseo-home>/worktrees/<8 位 base36 hash>/<slug>
const PASEO_WORKTREE = /(?:^|[\\/])worktrees[\\/][a-z0-9]{8}[\\/]([^\\/]+)(?:[\\/]|$)/;
// 外部布局通常是 <repo>/.local/worktrees/<name>
const WORKTREE_SEGMENT = /(?:^|[\\/])worktrees[\\/]([^\\/]+)(?:[\\/]|$)/;

function formatPillPath(cwdInput: string, workspaceDirectoryInput: string | null): string {
  const cwd = normalizeWindowsPath(cwdInput);
  const workspaceDirectory =
    workspaceDirectoryInput === null ? null : normalizeWindowsPath(workspaceDirectoryInput);

  // cwd 在 workspace 目录内时，前缀折叠成 ./，只显示相对路径；完整路径见 tooltip 和 popover
  if (workspaceDirectory) {
    const separator = separatorOf(workspaceDirectory);
    const cwdKey = comparisonKey(cwd);
    // cwd 就是 workspace 根时没有相对路径可显示，用 ./ 表示当前位置
    if (cwdKey === comparisonKey(workspaceDirectory)) {
      return separator === "\\" ? ".\\" : "./";
    }
    const prefix = workspaceDirectory.endsWith(separator)
      ? workspaceDirectory
      : `${workspaceDirectory}${separator}`;
    if (cwdKey.startsWith(comparisonKey(prefix))) {
      // workspace 本身就是 worktree 根时按 workspace 相对路径显示；
      // 否则 cwd 可能是 cd 进了 workspace 下的另一个 worktree，优先显示 worktree 名
      if (!worktreeNameOf(workspaceDirectory)) {
        const worktree = worktreeNameOf(cwd);
        if (worktree) return middleEllipsis(worktree, PILL_TEXT_UNITS);
      }
      return formatRelative(cwd.slice(prefix.length), separator);
    }
  }

  const worktree = worktreeNameOf(cwd);
  if (worktree) return middleEllipsis(worktree, PILL_TEXT_UNITS);
  return formatAbsolute(cwd);
}

function formatRelative(relative: string, separator: string): string {
  const prefix = separator === "\\" ? ".\\" : "./";
  const display = `${prefix}${relative}`;
  if (textUnits(display) <= PILL_TEXT_UNITS) return display;
  const segments = relative.split(/[\\/]/).filter((segment) => segment.length > 0);
  const head = `${prefix}…${separator}`;
  const available = PILL_TEXT_UNITS - textUnits(head);
  if (segments.length === 0 || available < 3) return middleEllipsis(display, PILL_TEXT_UNITS);
  return `${head}${middleEllipsis(segments[segments.length - 1], available)}`;
}

function formatAbsolute(cwd: string): string {
  const abbreviated =
    POSIX_HOME.test(cwd) || WINDOWS_HOME.test(cwd)
      ? cwd.replace(POSIX_HOME, "~").replace(WINDOWS_HOME, "~")
      : cwd;
  if (textUnits(abbreviated) <= PILL_TEXT_UNITS) return abbreviated;

  // 超长时锚定 home（或第一个路径段），省略中间，保留目录名首尾
  const separator = separatorOf(abbreviated);
  const segments = abbreviated.split(/[\\/]/).filter((segment) => segment.length > 0);
  if (segments.length === 0) return middleEllipsis(abbreviated, PILL_TEXT_UNITS);
  const head = abbreviated.startsWith("~")
    ? "~"
    : abbreviated.startsWith("/")
      ? `/${segments[0]}`
      : segments[0];
  const prefix = `${head}${separator}…${separator}`;
  const available = PILL_TEXT_UNITS - textUnits(prefix);
  if (available < 3) return middleEllipsis(abbreviated, PILL_TEXT_UNITS);
  return `${prefix}${middleEllipsis(segments[segments.length - 1], available)}`;
}

function separatorOf(path: string): string {
  return path.includes("\\") ? "\\" : "/";
}

function isWindowsPath(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith("\\\\");
}

// Windows 路径大小写不敏感，分隔符也可能混用；比较前统一成反斜杠
function normalizeWindowsPath(path: string): string {
  return isWindowsPath(path) ? path.replace(/\//g, "\\") : path;
}

function comparisonKey(path: string): string {
  return isWindowsPath(path) ? path.toLowerCase() : path;
}

function worktreeNameOf(cwd: string): string | null {
  return PASEO_WORKTREE.exec(cwd)?.[1] ?? WORKTREE_SEGMENT.exec(cwd)?.[1] ?? null;
}

// 中文等全角字符按两个字宽计，避免按字符数截断后在 pill 里超宽
function textUnits(value: string): number {
  let units = 0;
  for (const char of value) units += char.codePointAt(0)! > 0x7f ? 2 : 1;
  return units;
}

function middleEllipsis(value: string, maxUnits: number): string {
  if (textUnits(value) <= maxUnits) return value;
  const chars = Array.from(value);
  let head = 0;
  let tail = chars.length - 1;
  // 省略号按 textUnits 的规则占 2 个单位，避免最终结果比预算宽
  let used = textUnits("…");
  // 交替从首尾取字符，保留两端可辨认的部分
  while (head <= tail) {
    const headUnits = textUnits(chars[head]);
    if (used + headUnits > maxUnits) break;
    used += headUnits;
    head += 1;
    if (head > tail) break;
    const tailUnits = textUnits(chars[tail]);
    if (used + tailUnits > maxUnits) break;
    used += tailUnits;
    tail -= 1;
  }
  if (head === 0) return "…";
  return `${chars.slice(0, head).join("")}…${chars.slice(tail + 1).join("")}`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

interface AgentPill {
  workspaceId: string;
  registration: PluginButtonRegistration;
  subscription: PluginSubscriptionHandle;
}

/**
 * 为每个打开中的 agent 注册 composer pill。
 * agent 列表本身是 Paseo 的订阅推送；会话位置由插件订阅按 agent 推送。
 */
export function contributeLocationPills(client: PluginClientContext): () => void {
  const pills = new Map<string, AgentPill>();
  const lifetime = new AbortController();

  const removePill = (agentId: string) => {
    const pill = pills.get(agentId);
    if (!pill) return;
    pills.delete(agentId);
    pill.registration.remove();
    void pill.subscription.release().catch((error: unknown) => {
      if (!lifetime.signal.aborted) {
        console.error(`session-location: 释放 agent ${agentId} 订阅失败`, error);
      }
    });
  };

  const registerPill = (agent: PaseoAgent) => {
    if (lifetime.signal.aborted || !agent.workspaceId) return;
    const workspaceId = agent.workspaceId;
    const existing = pills.get(agent.id);
    if (existing?.workspaceId === workspaceId) return;
    if (existing) removePill(agent.id);

    const registration = client.addComposerPill({
      id: PILL_ID,
      workspaceId,
      agentId: agent.id,
      button: {
        title: "会话目录",
        icon: "Folder",
        label: "加载中",
        behavior: { kind: "popover", Content: LocationPopover },
      },
    });

    let subscription: PluginSubscriptionHandle;
    try {
      subscription = client.subscribe(
        locationSubscription,
        { agentId: agent.id },
        (snapshot) => {
          registration.update({
            title: `会话目录：${snapshot.cwd}`,
            label: formatPillPath(snapshot.cwd, snapshot.workspaceDirectory),
          });
        },
        {
          signal: lifetime.signal,
          onClosed: ({ error }) => {
            if (!error || lifetime.signal.aborted) return;
            console.error(`session-location: agent ${agent.id} 订阅关闭`, error);
            registration.update({ title: `会话目录不可用：${error.message}`, label: "不可用" });
          },
        },
      );
    } catch (error) {
      registration.remove();
      console.error(`session-location: 订阅 agent ${agent.id} 失败`, error);
      return;
    }

    // 订阅被 daemon 拒绝时 ready 会 reject，不消费会变成未处理的 rejection
    subscription.ready.catch((error: unknown) => {
      if (lifetime.signal.aborted) return;
      console.error(`session-location: agent ${agent.id} 订阅被拒绝`, error);
      registration.update({ title: "会话目录不可用", label: "不可用" });
    });

    pills.set(agent.id, { workspaceId, registration, subscription });
  };

  void (async () => {
    const first = await client.paseo.agents.list({ subscribe: {}, signal: lifetime.signal });
    const agents = first.entries.map((entry) => entry.agent);
    // 初始列表按页返回，超过 200 个活跃 agent 时后面的页要主动补齐
    let cursor = first.pageInfo.hasMore ? (first.pageInfo.nextCursor ?? null) : null;
    while (cursor) {
      const page = await client.paseo.agents.list({
        page: { limit: 200, cursor },
        signal: lifetime.signal,
      });
      agents.push(...page.entries.map((entry) => entry.agent));
      cursor = page.pageInfo.hasMore ? (page.pageInfo.nextCursor ?? null) : null;
    }

    const registerEntries = (current: readonly PaseoAgent[]) => {
      for (const agent of current) registerPill(agent);
    };
    registerEntries(agents);

    first.subscription.subscribe({
      // snapshot 只包含第一页，不能拿它判断 agent 是否已移除；移除由 kind: "remove" 更新通知
      snapshot: ({ entries: current }) => {
        registerEntries(current.map((entry) => entry.agent));
      },
      update: (message) => {
        if (message.type !== "agent_update") return;
        const update = message.payload;
        if (update.kind === "upsert") {
          registerPill(update.agent);
        } else {
          removePill(update.agentId);
        }
      },
      error: (error) => {
        if (!lifetime.signal.aborted) {
          console.error("session-location: agent 列表订阅失败", error);
        }
      },
    });
  })().catch((error: unknown) => {
    if (!lifetime.signal.aborted) {
      console.error("session-location: 订阅 agent 列表失败", error);
    }
  });

  return () => {
    lifetime.abort();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}

function AgentLocationPopover({
  theme,
  layout,
  host,
  agentId,
}: Pick<PluginHostProps, "theme" | "layout" | "host"> & { agentId: string }) {
  const [snapshot, setSnapshot] = useState<LocationSnapshot | null>(null);
  const subscription = useSubscription(locationSubscription, { agentId }, setSnapshot);
  const minWidth = layout.compact ? 220 : 280;

  const styles = useMemo(
    () => ({
      container: { gap: layout.compact ? 8 : 10, minWidth },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      row: {
        flexDirection: "row" as const,
        alignItems: "baseline" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      label: { color: theme.colors.foregroundMuted, fontSize: 12 },
      value: {
        color: theme.colors.foreground,
        fontSize: 12,
        flexShrink: 1,
        textAlign: "right" as const,
      },
      path: { color: theme.colors.foreground, fontSize: 13 },
      detail: { color: theme.colors.foregroundMuted, fontSize: 12 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
    }),
    [theme, layout.compact, minWidth],
  );

  const header = (
    <View style={styles.header}>
      <Icon name="Folder" size={14} color={theme.colors.foregroundMuted} />
      <Text style={styles.title}>会话目录</Text>
    </View>
  );

  if (subscription.status === "error") {
    return (
      <View style={styles.container}>
        {header}
        <Text style={styles.error}>订阅失败</Text>
        <Text style={styles.detail}>{subscription.error.message}</Text>
      </View>
    );
  }

  if (!snapshot) {
    return (
      <View style={styles.container}>
        {header}
        <Text style={styles.detail}>加载中...</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {header}
      <View style={{ gap: 2 }}>
        <Text style={styles.label}>完整路径</Text>
        <Text style={styles.path}>{snapshot.cwd}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>来源</Text>
        <Text style={styles.value}>
          {snapshot.cwdSource === "session" ? "会话记录" : "agent 快照"}
        </Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>workspace</Text>
        <Text style={styles.value}>{snapshot.workspaceTitle ?? "未知"}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>host</Text>
        <Text style={styles.value}>{host.label}</Text>
      </View>
      <View style={styles.row}>
        <Text style={styles.label}>agent</Text>
        <Text style={styles.value}>{snapshot.agentTitle ?? "未命名"}</Text>
      </View>
      <Text style={styles.detail}>更新于 {formatTime(snapshot.observedAt)}</Text>
    </View>
  );
}

function LocationPopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") return null;
  return (
    <AgentLocationPopover
      theme={props.theme}
      layout={props.layout}
      host={props.host}
      agentId={props.agentId}
    />
  );
}
