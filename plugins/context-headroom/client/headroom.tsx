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
import {
  headroomSubscription,
  type HeadroomSnapshot,
  type ThresholdInfo,
} from "../shared/headroom";

const PILL_ID = "headroom";

function formatInteger(value: number): string {
  const rounded = Math.round(value);
  const sign = rounded < 0 ? "-" : "";
  const digits = String(Math.abs(rounded));
  return `${sign}${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ",")}`;
}

function formatCompact(value: number): string {
  const abs = Math.abs(value);
  const sign = value < 0 ? "-" : "";
  if (abs >= 999_500) {
    return `${sign}${(abs / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (abs >= 1_000) {
    return `${sign}${Math.round(abs / 1_000)}k`;
  }
  return `${sign}${Math.round(abs)}`;
}

function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`;
}

function formatPercentValue(value: number): string {
  return Number.isInteger(value)
    ? String(value)
    : value.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

function pillLabel(snapshot: HeadroomSnapshot): string {
  switch (snapshot.status) {
    case "claude":
      if (snapshot.remaining < 0) return `超过 ${formatCompact(-snapshot.remaining)}`;
      return `${Math.round(snapshot.usedPct)}% · ${formatCompact(snapshot.remaining)}`;
    case "raw":
      return `${formatCompact(snapshot.usage.contextWindowUsedTokens)} / ${formatCompact(
        snapshot.usage.contextWindowMaxTokens,
      )}`;
    case "unavailable":
      return "不可用";
    case "no_usage":
      return "";
  }
}

function pillTitle(snapshot: HeadroomSnapshot): string {
  switch (snapshot.status) {
    case "claude":
      if (snapshot.remaining < 0) {
        return `上下文余量：已用 ${formatPercent(snapshot.usedPct)}，已超过压缩阈值 ${formatInteger(
          -snapshot.remaining,
        )} tokens`;
      }
      return `上下文余量：已用 ${formatPercent(snapshot.usedPct)}，剩余 ${formatInteger(
        snapshot.remaining,
      )} tokens`;
    case "raw":
      return `上下文余量：原始窗口已用 ${formatPercent(snapshot.usedPct)}，压缩阈值未知`;
    case "unavailable":
      return `上下文余量不可用：${snapshot.error}`;
    case "no_usage":
      return "上下文余量不可用：暂无 usage 数据";
  }
}

function autoSourceLabel(threshold: ThresholdInfo): string {
  if (threshold.autoSource === "settings") {
    return `CLAUDE_CODE_AUTO_COMPACT_WINDOW=${formatInteger(
      threshold.autoWindow,
    )}（${threshold.autoFile}）`;
  }
  return `context window=${formatInteger(threshold.autoWindow)}`;
}

function pctSourceLabel(threshold: ThresholdInfo): string {
  if (threshold.pctSource === "settings") {
    return `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=${formatPercentValue(threshold.pct)}%（${
      threshold.pctFile
    }）`;
  }
  return `${formatPercentValue(threshold.pct)}%（默认）`;
}

interface AgentPill {
  workspaceId: string;
  registration: PluginButtonRegistration;
  subscription: PluginSubscriptionHandle;
}

/**
 * 为每个打开中的 agent 注册 composer pill。
 * agent 列表本身是 Paseo 的订阅推送；usage 数值由插件订阅按 agent 推送。
 */
export function contributeHeadroomPills(client: PluginClientContext): () => void {
  const pills = new Map<string, AgentPill>();
  const lifetime = new AbortController();

  const removePill = (agentId: string) => {
    const pill = pills.get(agentId);
    if (!pill) return;
    pills.delete(agentId);
    pill.registration.remove();
    void pill.subscription.release().catch((error: unknown) => {
      if (!lifetime.signal.aborted) {
        console.error(`context-headroom: 释放 agent ${agentId} 订阅失败`, error);
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
        title: "上下文余量",
        icon: "Gauge",
        label: "加载中",
        // 没有 usage 的 agent 不占用 composer 空间
        visible: false,
        behavior: { kind: "popover", Content: HeadroomPopover },
      },
    });

    let subscription: PluginSubscriptionHandle;
    try {
      subscription = client.subscribe(
        headroomSubscription,
        { agentId: agent.id },
        (snapshot) => {
          registration.update({
            title: pillTitle(snapshot),
            label: pillLabel(snapshot),
            visible: snapshot.status !== "no_usage",
          });
        },
        {
          signal: lifetime.signal,
          onClosed: ({ error }) => {
            if (!error || lifetime.signal.aborted) return;
            console.error(`context-headroom: agent ${agent.id} 订阅关闭`, error);
            registration.update({ title: `上下文余量不可用：${error.message}`, label: "不可用", visible: true });
          },
        },
      );
    } catch (error) {
      registration.remove();
      console.error(`context-headroom: 订阅 agent ${agent.id} 失败`, error);
      return;
    }

    pills.set(agent.id, { workspaceId, registration, subscription });
  };

  void client.paseo.agents
    .list({ subscribe: {}, signal: lifetime.signal })
    .then(({ entries, subscription }) => {
      const registerEntries = (agents: readonly PaseoAgent[]) => {
        for (const agent of agents) registerPill(agent);
      };
      registerEntries(entries.map((entry) => entry.agent));

      subscription.subscribe({
        snapshot: ({ entries: current }) => {
          const currentIds = new Set(current.map((entry) => entry.agent.id));
          for (const agentId of [...pills.keys()]) {
            if (!currentIds.has(agentId)) removePill(agentId);
          }
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
            console.error("context-headroom: agent 列表订阅失败", error);
          }
        },
      });
    })
    .catch((error: unknown) => {
      if (!lifetime.signal.aborted) {
        console.error("context-headroom: 订阅 agent 列表失败", error);
      }
    });

  return () => {
    lifetime.abort();
    for (const pill of pills.values()) pill.registration.remove();
    pills.clear();
  };
}

function Meter({
  percent,
  width,
  theme,
}: {
  percent: number;
  width: number;
  theme: PluginHostProps["theme"];
}) {
  const clamped = Math.min(100, Math.max(0, percent));
  const color = percent > 100 ? theme.colors.statusDanger : theme.colors.accent;
  return (
    <View
      style={{
        width,
        height: 6,
        borderRadius: 3,
        backgroundColor: theme.colors.surface2,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: (clamped / 100) * width,
          height: "100%",
          backgroundColor: color,
        }}
      />
    </View>
  );
}

function AgentHeadroomPopover({
  theme,
  layout,
  agentId,
}: Pick<PluginHostProps, "theme" | "layout"> & { agentId: string }) {
  const [snapshot, setSnapshot] = useState<HeadroomSnapshot | null>(null);
  const subscription = useSubscription(headroomSubscription, { agentId }, setSnapshot);
  const meterWidth = layout.compact ? 200 : 240;

  const styles = useMemo(
    () => ({
      container: { gap: layout.compact ? 8 : 10, minWidth: meterWidth },
      header: { flexDirection: "row" as const, alignItems: "center" as const, gap: 6 },
      title: { color: theme.colors.foreground, fontSize: 13, fontWeight: "600" as const },
      row: {
        flexDirection: "row" as const,
        alignItems: "baseline" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      amount: {
        color: theme.colors.foreground,
        fontSize: 15,
        fontWeight: "600" as const,
        fontVariant: ["tabular-nums" as const],
      },
      detail: { color: theme.colors.foregroundMuted, fontSize: 12 },
      error: { color: theme.colors.statusDanger, fontSize: 12 },
      warning: { color: theme.colors.statusWarning, fontSize: 12 },
    }),
    [theme, layout.compact, meterWidth],
  );

  const header = (
    <View style={styles.header}>
      <Icon name="Gauge" size={14} color={theme.colors.foregroundMuted} />
      <Text style={styles.title}>上下文余量</Text>
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

  if (snapshot.status === "no_usage") {
    return (
      <View style={styles.container}>
        {header}
        <Text style={styles.detail}>当前 agent 暂无 usage 数据</Text>
      </View>
    );
  }

  if (snapshot.status === "unavailable") {
    return (
      <View style={styles.container}>
        {header}
        <Text style={styles.error}>上下文余量不可用</Text>
        <Text style={styles.detail}>{snapshot.error}</Text>
        {snapshot.usage?.contextWindowUsedTokens !== null &&
        snapshot.usage?.contextWindowUsedTokens !== undefined ? (
          <Text style={styles.detail}>
            原始已用 {formatInteger(snapshot.usage.contextWindowUsedTokens)} tokens
          </Text>
        ) : null}
        {snapshot.usage?.contextWindowMaxTokens !== null &&
        snapshot.usage?.contextWindowMaxTokens !== undefined ? (
          <Text style={styles.detail}>
            窗口 {formatInteger(snapshot.usage.contextWindowMaxTokens)} tokens
          </Text>
        ) : null}
        <Text style={styles.detail}>provider {snapshot.provider}</Text>
        <Text style={styles.detail}>更新于 {formatTime(snapshot.observedAt)}</Text>
      </View>
    );
  }

  if (snapshot.status === "raw") {
    return (
      <View style={styles.container}>
        {header}
        <View style={styles.row}>
          <Text style={styles.amount}>
            {formatInteger(snapshot.usage.contextWindowUsedTokens)} /{" "}
            {formatInteger(snapshot.usage.contextWindowMaxTokens)}
          </Text>
          <Text style={styles.detail}>{formatPercent(snapshot.usedPct)}</Text>
        </View>
        <Meter percent={snapshot.usedPct} width={meterWidth} theme={theme} />
        {snapshot.remaining < 0 ? (
          <Text style={styles.error}>
            已超过 context window {formatInteger(-snapshot.remaining)} tokens
          </Text>
        ) : (
          <Text style={styles.detail}>
            距窗口上限 {formatInteger(snapshot.remaining)} tokens
          </Text>
        )}
        <Text style={styles.warning}>
          压缩阈值未知：当前只精确支持 Claude Code provider
        </Text>
        <Text style={styles.detail}>provider {snapshot.provider}</Text>
        <Text style={styles.detail}>更新于 {formatTime(snapshot.observedAt)}</Text>
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {header}
      <View style={styles.row}>
        <Text style={styles.amount}>
          {formatInteger(snapshot.used)} / {formatInteger(snapshot.threshold.value)}
        </Text>
        <Text style={styles.detail}>{formatPercent(snapshot.usedPct)}</Text>
      </View>
      <Meter percent={snapshot.usedPct} width={meterWidth} theme={theme} />
      {snapshot.remaining < 0 ? (
        <Text style={styles.error}>
          已超过压缩阈值 {formatInteger(-snapshot.remaining)} tokens
        </Text>
      ) : (
        <Text style={styles.detail}>剩余 {formatInteger(snapshot.remaining)} tokens</Text>
      )}
      <Text style={styles.detail}>
        窗口 {formatInteger(snapshot.usage.contextWindowMaxTokens)} tokens
      </Text>
      <Text style={styles.detail}>
        阈值 {formatInteger(snapshot.threshold.value)} = min(
        {formatInteger(snapshot.threshold.autoWindow)},{" "}
        {formatInteger(snapshot.usage.contextWindowMaxTokens)}) ×{" "}
        {formatPercentValue(snapshot.threshold.pct)}%
      </Text>
      <Text style={styles.detail}>窗口来源：{autoSourceLabel(snapshot.threshold)}</Text>
      <Text style={styles.detail}>百分比：{pctSourceLabel(snapshot.threshold)}</Text>
      {snapshot.includesOutput ? (
        <Text style={styles.warning}>已用 token 包含输出（未能精确扣除）</Text>
      ) : null}
      <Text style={styles.detail}>provider {snapshot.provider}</Text>
      <Text style={styles.detail}>更新于 {formatTime(snapshot.observedAt)}</Text>
    </View>
  );
}

function HeadroomPopover(props: PluginButtonContentProps) {
  if (props.context !== "agent") return null;
  return (
    <AgentHeadroomPopover
      theme={props.theme}
      layout={props.layout}
      agentId={props.agentId}
    />
  );
}
