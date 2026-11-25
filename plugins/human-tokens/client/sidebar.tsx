import type { PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { Text, View } from "react-native";
import { MeasurementHost } from "./driver";
import { formatPercent, formatTokens } from "./format";
import { useStats } from "./use-stats";

/**
 * 侧边栏只放一行扫一眼够用的读数：↓ 读入总量、↑ 输入总量、cache miss。
 * 读速和写速在插件页面里，不靠 hover：手机没有 hover，悬停也不容易被发现。
 * huken 是显示名，插件 ID 仍是 human-tokens。
 */
export function HumanTokensSidebarItem({
  theme,
  currentScreen,
  openScreen,
}: PluginSidebarItemProps) {
  const { data } = useStats(7);
  const active = currentScreen?.screenId === "main";
  const stats = data?.lifetime;
  const hasStats = !!stats && stats.readTokens > 0;
  const mutedStyle = {
    color: theme.colors.foregroundMuted,
    fontSize: 11,
    fontVariant: ["tabular-nums" as const],
  };
  const valueStyle = {
    color: theme.colors.foreground,
    fontSize: 11,
    fontVariant: ["tabular-nums" as const],
  };

  return (
    <>
      <SidebarRow
        icon="BookOpen"
        label="huken"
        active={active}
        onPress={() => openScreen({ screenId: "main" })}
        trailing={
          hasStats && stats ? (
            <View
              style={{ flexDirection: "row", alignItems: "baseline", gap: 10 }}
            >
              <View
                style={{ flexDirection: "row", alignItems: "baseline", gap: 3 }}
              >
                <Text style={mutedStyle}>↓</Text>
                <Text style={valueStyle}>
                  {formatTokens(stats.readTokens)}
                </Text>
              </View>
              <Text style={mutedStyle}>
                {`↑ ${formatTokens(stats.typedChars)}`}
              </Text>
              <Text style={mutedStyle}>
                {`miss ${formatPercent(
                  stats.missTokens,
                  stats.completedTokens,
                )}`}
              </Text>
            </View>
          ) : undefined
        }
      />
      <MeasurementHost />
    </>
  );
}
