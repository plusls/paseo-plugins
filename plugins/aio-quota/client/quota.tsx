import {
  useRpc,
  type PluginPopoverProps,
  type PluginSidebarItemProps,
} from "@getpaseo/plugin/client";
import { Icon, SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import {
  quotaSnapshotRpc,
  remainingPercent,
  type QuotaSnapshot,
  type QuotaWindowSnapshot,
} from "../shared/quota";

export const SNAPSHOT_QUERY_KEY = ["aio-quota", "snapshot"];
const REFRESH_INTERVAL_MS = 60_000;
const FOOTER_METER_WIDTH = 56;
const FOOTER_METER_WIDTH_COMPACT = 48;
const FOOTER_METER_HEIGHT = 4;
const METER_HEIGHT = 6;
const POPOVER_METER_WIDTH = 220;
const POPOVER_METER_WIDTH_COMPACT = 180;
const QUOTA_LABEL = "Codex";

type QuotaTone = "success" | "warning" | "danger";

function useQuotaSnapshot(options: { refetchOnMount?: boolean } = {}) {
  const fetchSnapshot = useRpc(quotaSnapshotRpc);
  const queryClient = useQueryClient();
  const query = useQuery({
    queryKey: SNAPSHOT_QUERY_KEY,
    queryFn: () => fetchSnapshot({}),
    refetchInterval: REFRESH_INTERVAL_MS,
    // popover 挂载时不自带普通请求，避免和点击触发的 forceRefresh 竞争；
    // footer 的观察者已经维持同一个 query
    refetchOnMount: options.refetchOnMount ?? true,
    // 失败后由下一次自动刷新重试，这里不叠加请求级重试
    retry: false,
  });
  // 手动刷新绕过服务端缓存；先取消同键的进行中请求，
  // 否则 fetchQuery 会复用自动刷新的 Promise，forceRefresh 不会执行。
  // 失败结果由 query.error 展示，这里吞掉 rejection，避免产生未处理的异常。
  const refresh = async () => {
    await queryClient.cancelQueries({ queryKey: SNAPSHOT_QUERY_KEY });
    return queryClient
      .fetchQuery({
        queryKey: SNAPSHOT_QUERY_KEY,
        queryFn: () => fetchSnapshot({ forceRefresh: true }),
        staleTime: 0,
        retry: false,
      })
      .catch(() => undefined);
  };
  return { query, refresh };
}

function toneFor(remaining: number, limitReached: boolean): QuotaTone {
  if (limitReached || remaining <= 10) return "danger";
  if (remaining <= 30) return "warning";
  return "success";
}

function toneColor(tone: QuotaTone, theme: PluginSidebarItemProps["theme"]): string {
  switch (tone) {
    case "danger":
      return theme.colors.statusDanger;
    case "warning":
      return theme.colors.statusWarning;
    case "success":
      return theme.colors.statusSuccess;
  }
}

function formatPercent(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return Number.isInteger(rounded) ? `${rounded}%` : `${rounded.toFixed(1)}%`;
}

function formatWindowLength(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400} 天`;
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`;
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`;
  return `${seconds} 秒`;
}

function windowTitle(quotaWindow: QuotaWindowSnapshot): string {
  const kind = quotaWindow.kind === "primary" ? "主窗口" : "次窗口";
  return `${kind} ${formatWindowLength(quotaWindow.limitWindowSeconds)}`;
}

// footer 只显示一行，取所有可用窗口里最低的剩余比例，避免漏掉更紧的窗口
function footerSummary(
  snapshot: QuotaSnapshot,
): { remaining: number; limitReached: boolean } | null {
  const rateLimit = snapshot.rateLimit;
  if (rateLimit === null || rateLimit.windows.length === 0) return null;
  return {
    remaining: Math.min(
      ...rateLimit.windows.map((quotaWindow) => remainingPercent(quotaWindow.usedPercent)),
    ),
    limitReached: rateLimit.limitReached,
  };
}

function formatResetTime(epochMs: number): string {
  const date = new Date(epochMs);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

// resetAfterSeconds 以服务端响应时刻为基准，这里用本地接收时间做锚点，
// 不依赖 daemon 和客户端的绝对时钟一致
function formatCountdown(resetAtMs: number): string {
  const seconds = Math.floor((resetAtMs - Date.now()) / 1000);
  if (seconds <= 0) return "即将重置";
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days} 天 ${hours} 小时后重置`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分钟后重置`;
  if (minutes > 0) return `${minutes} 分钟后重置`;
  return `${seconds} 秒后重置`;
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function QuotaMeter({
  percent,
  limitReached,
  width,
  height = METER_HEIGHT,
  theme,
}: {
  percent: number;
  limitReached: boolean;
  width: number;
  height?: number;
  theme: PluginSidebarItemProps["theme"];
}) {
  const color = toneColor(toneFor(percent, limitReached), theme);
  return (
    <View
      style={{
        width,
        height,
        borderRadius: height / 2,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: (percent / 100) * width,
          height: "100%",
          borderRadius: height / 2,
          backgroundColor: color,
        }}
      />
    </View>
  );
}

function RefreshAction({
  theme,
  busy,
  onPress,
}: {
  theme: PluginSidebarItemProps["theme"];
  busy: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="刷新额度"
      disabled={busy}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 4,
        paddingVertical: 6,
        paddingHorizontal: 4,
        opacity: busy ? 0.5 : pressed ? 0.7 : 1,
      })}
    >
      <Icon name="RotateCw" size={12} color={theme.colors.foregroundMuted} />
      <Text style={{ color: theme.colors.foregroundMuted, fontSize: 12 }}>
        {busy ? "刷新中..." : "刷新"}
      </Text>
    </Pressable>
  );
}

function QuotaPopover({ theme, layout }: PluginPopoverProps) {
  const { query, refresh } = useQuotaSnapshot({ refetchOnMount: false });
  const styles = useMemo(
    () => ({
      container: { gap: layout.compact ? 10 : 14 },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      windowBlock: { gap: 3 },
      windowTitle: {
        color: theme.colors.foreground,
        fontSize: 13,
        fontWeight: "600" as const,
      },
      value: { color: theme.colors.foreground, fontSize: 13 },
      detail: { color: theme.colors.foregroundMuted, fontSize: 12 },
      danger: { color: theme.colors.statusDanger, fontSize: 13 },
      footerRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
    }),
    [theme, layout.compact],
  );
  const header = (
    <View style={styles.header}>
      <Icon name="Gauge" size={14} color={theme.colors.foregroundMuted} />
      <Text style={styles.title}>Codex 额度</Text>
    </View>
  );
  const refreshAction = (
    <RefreshAction theme={theme} busy={query.isFetching} onPress={() => void refresh()} />
  );

  if (query.isError) {
    return (
      <View style={styles.container}>
        {header}
        <Text style={styles.danger}>额度不可用</Text>
        <Text style={styles.detail}>{query.error.message}</Text>
        {refreshAction}
      </View>
    );
  }

  const snapshot = query.data;
  if (!snapshot) {
    return (
      <View style={styles.container}>
        {header}
        <Text style={styles.detail}>额度加载中...</Text>
      </View>
    );
  }

  const rateLimit = snapshot.rateLimit;
  return (
    <View style={styles.container}>
      {header}
      <Text style={styles.detail}>套餐 {snapshot.planType}</Text>
      {rateLimit === null || rateLimit.windows.length === 0 ? (
        <Text style={styles.detail}>无可用额度窗口</Text>
      ) : (
        rateLimit.windows.map((quotaWindow) => {
          const remaining = remainingPercent(quotaWindow.usedPercent);
          const resetAtMs = query.dataUpdatedAt + quotaWindow.resetAfterSeconds * 1000;
          const resetTime = formatResetTime(resetAtMs);
          const countdown = formatCountdown(resetAtMs);
          return (
            <View key={quotaWindow.kind} style={styles.windowBlock}>
              <Text style={styles.windowTitle}>{windowTitle(quotaWindow)}</Text>
              <Text style={styles.value}>
                已用 {formatPercent(quotaWindow.usedPercent)}，剩余 {formatPercent(remaining)}
              </Text>
              <QuotaMeter
                percent={remaining}
                limitReached={rateLimit.limitReached}
                width={layout.compact ? POPOVER_METER_WIDTH_COMPACT : POPOVER_METER_WIDTH}
                theme={theme}
              />
              <Text style={styles.detail}>
                重置时间 {resetTime}（{countdown}）
              </Text>
            </View>
          );
        })
      )}
      {rateLimit !== null && rateLimit.limitReached ? (
        <Text style={styles.danger}>额度已达上限</Text>
      ) : null}
      <View style={styles.footerRow}>
        <Text style={styles.detail}>
          {query.isFetching ? "刷新中..." : `更新于 ${formatTime(snapshot.fetchedAt)}`}
        </Text>
        {refreshAction}
      </View>
    </View>
  );
}

interface QuotaRowProps {
  summary: { remaining: number; limitReached: boolean };
  theme: PluginSidebarItemProps["theme"];
  compact: boolean;
  onPress: () => void;
}

function QuotaRow({ summary, theme, compact, onPress }: QuotaRowProps) {
  const [hovered, setHovered] = useState(false);
  const tone = toneFor(summary.remaining, summary.limitReached);
  const percentColor =
    tone === "success" ? theme.colors.foreground : toneColor(tone, theme);
  const textColor = hovered ? theme.colors.foreground : theme.colors.foregroundMuted;

  // SidebarRow 的 label 不能设 numberOfLines，这里自己排版成单行：
  // 12px 名称 + 剩余百分比 + 细条，交互样式对齐原生侧边栏行
  return (
    <Pressable
      accessible
      accessibilityRole="button"
      accessibilityLabel={`${QUOTA_LABEL}，剩余 ${formatPercent(summary.remaining)}${
        summary.limitReached ? "，额度已达上限" : ""
      }`}
      onPress={onPress}
      onHoverIn={() => setHovered(true)}
      onHoverOut={() => setHovered(false)}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 8,
        minHeight: compact ? 44 : 28,
        paddingVertical: compact ? 6 : 2,
        paddingHorizontal: 8,
        borderRadius: 8,
        backgroundColor: pressed || hovered ? theme.colors.surface2 : "transparent",
      })}
    >
      <Icon name="Gauge" size={compact ? 18 : 14} color={textColor} />
      <Text numberOfLines={1} style={{ flex: 1, minWidth: 0, color: textColor, fontSize: 12 }}>
        {QUOTA_LABEL}
      </Text>
      <View style={{ alignItems: "flex-end", gap: 3 }}>
        <Text style={{ color: percentColor, fontSize: 12, fontVariant: ["tabular-nums"] }}>
          {formatPercent(summary.remaining)}
        </Text>
        <QuotaMeter
          percent={summary.remaining}
          limitReached={summary.limitReached}
          width={compact ? FOOTER_METER_WIDTH_COMPACT : FOOTER_METER_WIDTH}
          height={FOOTER_METER_HEIGHT}
          theme={theme}
        />
      </View>
    </Pressable>
  );
}

export function QuotaFooterItem({ theme, layout, openPopover }: PluginSidebarItemProps) {
  const { query, refresh } = useQuotaSnapshot();
  const openDetails = () => {
    // 点击时绕过缓存重新查询，明细弹层会随 query 更新
    void refresh();
    openPopover(QuotaPopover);
  };

  if (query.isError) {
    return <SidebarRow icon="Gauge" label="额度不可用" onPress={openDetails} />;
  }

  const snapshot = query.data;
  if (!snapshot) {
    return <SidebarRow icon="Gauge" label="额度加载中..." onPress={openDetails} />;
  }

  const summary = footerSummary(snapshot);
  if (summary === null) {
    return <SidebarRow icon="Gauge" label="Codex 无可用额度窗口" onPress={openDetails} />;
  }

  return (
    <QuotaRow summary={summary} theme={theme} compact={layout.compact} onPress={openDetails} />
  );
}
