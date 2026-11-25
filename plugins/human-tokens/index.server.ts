import type { PluginServerContext } from "@getpaseo/plugin/server";
import { ingestRpc, statsRpc } from "./shared/protocol";
import { ingest, openDatabase, queryStats } from "./server/db";

export default function contribute(server: PluginServerContext) {
  const db = openDatabase();
  server.handle(ingestRpc, (input) => ingest(db, input));
  server.handle(statsRpc, (input) => queryStats(db, input));

  return () => {
    db.close();
  };
}
