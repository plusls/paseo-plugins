import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { ScrollView } from "@getpaseo/plugin/client/ui";
import { useMemo, useState } from "react";
import { Pressable, Text, View } from "react-native";
import type { Daily } from "../shared/protocol";
import {
  formatDayLabel,
  formatDuration,
  formatPercent,
  formatRate,
  formatTokens,
} from "./format";
import { useStats } from "./use-stats";

interface ChartSeries {
  label: string;
  color: string;
  value: (day: Daily) => number;
}

function shouldShowDay(index: number, count: number): boolean {
  if (count <= 7) return true;
  return index % 5 === 0 || index === count - 1;
}

function DailyChart({
  days,
  series,
  theme,
  compact,
}: {
  days: readonly Daily[];
  series: readonly ChartSeries[];
  theme: PluginTheme;
  compact: boolean;
}) {
  const [selectedDay, setSelectedDay] = useState<string | null>(null);
  const height = compact ? 56 : 72;
  const selected =
    days.find((day) => day.day === selectedDay) ?? days[days.length - 1] ?? null;
  const max = Math.max(
    1,
    ...days.map((day) =>
      series.reduce((sum, item) => sum + item.value(day), 0),
    ),
  );

  const styles = useMemo(
    () => ({
      legendRow: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 12,
      },
      legend: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 4,
      },
      legendDot: { width: 8, height: 8, borderRadius: 2 },
      legendText: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
      },
      chartRow: {
        flexDirection: "row" as const,
        alignItems: "flex-end" as const,
        height,
        gap: 2,
      },
      chartColumn: {
        flex: 1,
        height,
        alignItems: "center" as const,
        justifyContent: "flex-end" as const,
      },
      barGroup: { width: "70%" as const, justifyContent: "flex-end" as const },
      dayRow: { flexDirection: "row" as const, gap: 2 },
      dayLabel: {
        flex: 1,
        textAlign: "center" as const,
        color: theme.colors.foregroundMuted,
        fontSize: 9,
      },
      detail: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      },
    }),
    [theme, height],
  );

  return (
    <View style={{ gap: 6 }}>
      <View style={styles.legendRow}>
        {series.map((item) => (
          <View key={item.label} style={styles.legend}>
            <View style={[styles.legendDot, { backgroundColor: item.color }]} />
            <Text style={styles.legendText}>{item.label}</Text>
          </View>
        ))}
      </View>

      <View style={styles.chartRow}>
        {days.map((day) => {
          const values = series.map((item) => item.value(day));
          return (
            <Pressable
              key={day.day}
              onPress={() => setSelectedDay(day.day)}
              accessibilityRole="button"
              accessibilityLabel={`${day.day} ${series
                .map((item, index) => `${item.label} ${formatTokens(values[index])}`)
                .join("，")}`}
              style={styles.chartColumn}
            >
              <View style={styles.barGroup}>
                {/* 反序渲染，让 series[0] 在底部 */}
                {series
                  .map((item, index) => ({ item, index }))
                  .reverse()
                  .map(({ index }) => {
                    const barHeight = Math.max(
                      0,
                      Math.round((values[index] / max) * height),
                    );
                    return (
                      <View
                        key={series[index].label}
                        style={{
                          height: barHeight,
                          backgroundColor: series[index].color,
                          borderRadius: 1,
                        }}
                      />
                    );
                  })}
              </View>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.dayRow}>
        {days.map((day, index) => (
          <Text key={day.day} style={styles.dayLabel} numberOfLines={1}>
            {shouldShowDay(index, days.length) ? formatDayLabel(day.day) : ""}
          </Text>
        ))}
      </View>

      {selected ? (
        <Text style={styles.detail}>
          {formatDayLabel(selected.day)}{" / "}
          {series
            .map(
              (item) =>
                `${item.label} ${formatTokens(item.value(selected))}`,
            )
            .join(" / ")}
        </Text>
      ) : null}
    </View>
  );
}

export function HumanTokensScreen({ theme, layout }: PluginScreenProps) {
  const compact = layout.compact;
  const [period, setPeriod] = useState<7 | 30>(7);
  const [refreshKey, setRefreshKey] = useState(0);
  const { data, error, loading } = useStats(period, refreshKey);

  const styles = useMemo(
    () => ({
      screen: { flex: 1, backgroundColor: theme.colors.surface0 },
      content: {
        padding: compact ? 16 : 24,
        gap: compact ? 12 : 16,
      },
      header: {
        flexDirection: "row" as const,
        alignItems: "center" as const,
        gap: 12,
      },
      title: {
        color: theme.colors.foreground,
        fontSize: compact ? 20 : 24,
        fontWeight: "600" as const,
      },
      subtitle: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 11 : 12,
      },
      legend: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        marginTop: 2,
      },
      card: {
        backgroundColor: theme.colors.surface1,
        borderRadius: 12,
        borderWidth: 1,
        borderColor: theme.colors.border,
        padding: compact ? 12 : 16,
        gap: compact ? 8 : 10,
      },
      sectionTitle: {
        color: theme.colors.foreground,
        fontSize: compact ? 13 : 14,
        fontWeight: "600" as const,
      },
      muted: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 11 : 12,
      },
      empty: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 12 : 13,
        lineHeight: compact ? 18 : 20,
      },
      errorCard: {
        backgroundColor: theme.colors.surface1,
        borderColor: theme.colors.statusDanger,
        borderWidth: 1,
        borderRadius: 10,
        padding: 12,
        gap: 4,
      },
      errorText: {
        color: theme.colors.statusDanger,
        fontSize: 11,
      },
      refresh: {
        paddingHorizontal: 10,
        paddingVertical: 6,
        borderRadius: 8,
        backgroundColor: theme.colors.surface2,
      },
      refreshText: {
        color: theme.colors.foreground,
        fontSize: 11,
      },
      toggle: {
        flexDirection: "row" as const,
        gap: 6,
        backgroundColor: theme.colors.surface1,
        padding: 3,
        borderRadius: 9,
        alignSelf: "flex-start" as const,
      },
      toggleItem: {
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 7,
      },
      toggleActive: { backgroundColor: theme.colors.accent },
      toggleText: {
        color: theme.colors.foregroundMuted,
        fontSize: 11,
      },
      toggleTextActive: {
        color: theme.colors.accentForeground,
        fontWeight: "600" as const,
      },
      metricRow: { gap: 1 },
      metricLine: {
        flexDirection: "row" as const,
        alignItems: "baseline" as const,
        justifyContent: "space-between" as const,
        gap: 8,
      },
      metricLabel: {
        color: theme.colors.foreground,
        fontSize: compact ? 12 : 13,
      },
      metricHint: {
        color: theme.colors.foregroundMuted,
        fontSize: compact ? 10 : 11,
      },
      metricValue: {
        color: theme.colors.foreground,
        fontSize: compact ? 13 : 14,
        fontWeight: "600" as const,
        fontVariant: ["tabular-nums" as const],
      },
      todayRow: {
        flexDirection: "row" as const,
        gap: 12,
        flexWrap: "wrap" as const,
      },
      todayItem: { gap: 2, minWidth: 64 },
      todayValue: {
        color: theme.colors.foreground,
        fontSize: compact ? 16 : 18,
        fontWeight: "600" as const,
        fontVariant: ["tabular-nums" as const],
      },
      note: {
        color: theme.colors.foregroundMuted,
        fontSize: 10,
        lineHeight: 15,
      },
    }),
    [theme, compact],
  );

  const lifetime = data?.lifetime;
  const today = data?.today;
  const daily = data?.daily ?? [];
  const hasData =
    !!lifetime &&
    (lifetime.producedTokens > 0 ||
      lifetime.typedChars > 0 ||
      lifetime.readTokens > 0);

  const metric = (label: string, value: string, hint?: string) => (
    <View key={label} style={styles.metricRow}>
      <View style={styles.metricLine}>
        <Text style={styles.metricLabel}>{label}</Text>
        <Text style={styles.metricValue}>{value}</Text>
      </View>
      {hint ? <Text style={styles.metricHint}>{hint}</Text> : null}
    </View>
  );

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={styles.content}
    >
      <View style={styles.header}>
        <View style={{ flex: 1 }}>
          <Text style={styles.title}>huken</Text>
          <Text style={styles.subtitle}>AI 吃 token，人类烧 huken</Text>
          <Text style={styles.legend}>↓ AI 输出读入 · ↑ 人类输入</Text>
        </View>
        <Pressable
          accessibilityRole="button"
          onPress={() => setRefreshKey((value) => value + 1)}
          style={styles.refresh}
        >
          <Text style={styles.refreshText}>{loading ? "刷新中" : "刷新"}</Text>
        </Pressable>
      </View>

      <View style={styles.toggle}>
        {([7, 30] as const).map((value) => (
          <Pressable
            key={value}
            accessibilityRole="button"
            onPress={() => setPeriod(value)}
            style={[
              styles.toggleItem,
              period === value && styles.toggleActive,
            ]}
          >
            <Text
              style={[
                styles.toggleText,
                period === value && styles.toggleTextActive,
              ]}
            >
              {value} 天
            </Text>
          </Pressable>
        ))}
      </View>

      {error ? (
        <View style={styles.errorCard}>
          <Text style={styles.errorText}>{error}</Text>
        </View>
      ) : null}

      {!data && loading ? (
        <Text style={styles.muted}>加载中...</Text>
      ) : null}

      {!hasData && !loading ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>还没有数据</Text>
          <Text style={styles.empty}>
            打开一个 agent，等 AI 回复完成并在屏幕上停留一会儿，读过的内容
            才会记入；不会补算历史。
          </Text>
        </View>
      ) : null}

      {lifetime ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>人类用量账单</Text>
          {metric(
            "人类输入",
            `${formatTokens(lifetime.typedChars)} tok`,
            "只算真实输入，粘贴不算",
          )}
          {metric(
            "AI 产出",
            `${formatTokens(lifetime.producedTokens)} tok`,
            "插件见过的 AI 回复",
          )}
          {metric(
            "实际读入",
            `${formatTokens(lifetime.readTokens)} tok`,
            `已读比例 ${formatPercent(lifetime.readTokens, lifetime.producedTokens)}`,
          )}
          {metric(
            "读速",
            formatRate(lifetime.readTokens, lifetime.activeReadMs),
            `首次阅读时间 ${formatDuration(lifetime.activeReadMs)}`,
          )}
          {metric(
            "回读速度",
            formatRate(lifetime.missTokens, lifetime.activeReviewMs),
            `本地回看 ${formatDuration(lifetime.activeReviewMs)}，跨会话回读未计时`,
          )}
          {metric(
            "输出速度",
            formatRate(lifetime.typedChars, lifetime.activeTypingMs),
            `人类输入 / 活跃输入时间 ${formatDuration(lifetime.activeTypingMs)}`,
          )}
          {metric(
            "回读占比",
            formatPercent(lifetime.missTokens, lifetime.completedTokens),
            "回读的 token 占已读完内容的比例",
          )}
          {metric(
            "重读次数",
            String(lifetime.revisits),
            "同一段内容隔一会儿再回来看，算一次重读",
          )}
          {metric("切换 agent", String(lifetime.switches))}
          {metric("消息数", String(lifetime.messages))}
          <Text style={styles.note}>
            1 huken = 1 个字符，用于比较趋势，不是模型的计费 token。
            阅读时间按停留时间估算，不判断是否真的在看。
          </Text>
        </View>
      ) : null}

      {today ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>今天</Text>
          <View style={styles.todayRow}>
            <View style={styles.todayItem}>
              <Text style={styles.todayValue}>
                {formatTokens(today.typedChars)}
              </Text>
              <Text style={styles.muted}>输入 tok</Text>
            </View>
            <View style={styles.todayItem}>
              <Text style={styles.todayValue}>
                {formatTokens(today.readTokens)}
              </Text>
              <Text style={styles.muted}>读入 tok</Text>
            </View>
            <View style={styles.todayItem}>
              <Text style={styles.todayValue}>
                {formatTokens(today.missTokens)}
              </Text>
              <Text style={styles.muted}>回读 tok</Text>
            </View>
            <View style={styles.todayItem}>
              <Text style={styles.todayValue}>{String(today.revisits)}</Text>
              <Text style={styles.muted}>重读</Text>
            </View>
            <View style={styles.todayItem}>
              <Text style={styles.todayValue}>{String(today.switches)}</Text>
              <Text style={styles.muted}>切换</Text>
            </View>
          </View>
        </View>
      ) : null}

      {hasData ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>每日阅读 token</Text>
          <DailyChart
            days={daily}
            theme={theme}
            compact={compact}
            series={[
              {
                label: "首次阅读",
                color: theme.colors.accent,
                value: (day) => day.readTokens,
              },
              {
                label: "回读",
                color: theme.colors.statusWarning,
                value: (day) => day.missTokens,
              },
            ]}
          />
        </View>
      ) : null}

      {hasData ? (
        <View style={styles.card}>
          <Text style={styles.sectionTitle}>每日输入 token</Text>
          <DailyChart
            days={daily}
            theme={theme}
            compact={compact}
            series={[
              {
                label: "人类输入",
                color: theme.colors.statusSuccess,
                value: (day) => day.typedChars,
              },
            ]}
          />
        </View>
      ) : null}

      <Text style={styles.note}>
        统计数据只保存在 Paseo 的插件数据里，聊天正文不会上传或保存。
      </Text>
    </ScrollView>
  );
}
