import type { PluginServerContext } from "@getpaseo/plugin/server";
import { watchAgentLocation } from "./server/location";
import { locationSubscription } from "./shared/location";

export default function contribute(server: PluginServerContext) {
  server.handle(locationSubscription, watchAgentLocation);
  return () => {};
}
