import { defineSubscription } from "@getpaseo/plugin";
import { z } from "zod";

/**
 * 一个 agent 的会话位置。cwd 优先来自 provider 会话记录，读不到时回退 agent 快照；
 * 不来自 workspace：agent 在会话里 cd 到 worktree 后，workspace 的 directory 仍然是主 checkout。
 */
export const locationSnapshotSchema = z.object({
  agentId: z.string(),
  cwd: z.string(),
  // session：从 provider 会话记录读到；snapshot：回退到 Paseo agent 快照
  cwdSource: z.enum(["session", "snapshot"]),
  agentTitle: z.string().nullable(),
  workspaceTitle: z.string().nullable(),
  // workspace 实际目录，用于把 cwd 前缀折叠成相对路径
  workspaceDirectory: z.string().nullable(),
  observedAt: z.string(),
});

export const locationSubscription = defineSubscription({
  name: "session-location.watch",
  input: z.object({ agentId: z.string() }),
  event: locationSnapshotSchema,
});

export type LocationSnapshot = z.infer<typeof locationSnapshotSchema>;
