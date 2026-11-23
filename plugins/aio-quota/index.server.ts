import type { PluginServerContext } from "@getpaseo/plugin/server";
import { getQuotaSnapshot } from "./server/quota";
import { quotaSnapshotRpc } from "./shared/quota";
import { quotaSettings } from "./shared/settings";

export default function contribute(server: PluginServerContext) {
  const settings = server.registerSettings(quotaSettings);

  server.handle(quotaSnapshotRpc, async (input) => {
    const state = await settings.read();
    if (state.status !== "ready") {
      throw new Error(`额度配置不可用：${state.error}`);
    }
    return getQuotaSnapshot(state.values.usageUrl, input.forceRefresh === true);
  });

  return () => {};
}
