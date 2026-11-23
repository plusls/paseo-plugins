import type { PluginServerContext } from "@getpaseo/plugin/server";
import { watchAgentHeadroom } from "./server/headroom";
import { headroomSubscription } from "./shared/headroom";

export default function contribute(server: PluginServerContext) {
  server.handle(headroomSubscription, watchAgentHeadroom);
  return () => {};
}
