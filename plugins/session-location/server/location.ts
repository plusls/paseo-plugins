import type { PaseoAgent, PaseoWorkspace, PaseoWorkspaceListResult } from "@getpaseo/client";
import type { SubscriptionEvent, SubscriptionInput } from "@getpaseo/plugin";
import type { PluginSubscriptionContext } from "@getpaseo/plugin/server";
import { watch, type FSWatcher } from "node:fs";
import { locationSubscription, type LocationSnapshot } from "../shared/location";
import { openSessionTranscript, type SessionTranscript } from "./transcript";

type LocationSubscriptionInput = SubscriptionInput<typeof locationSubscription>;
type LocationSubscriptionEvent = SubscriptionEvent<typeof locationSubscription>;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function signatureOf(snapshot: LocationSnapshot): string {
  // observedAt 只表示推送时间，不参与内容是否变化的判断
  const copy: Record<string, unknown> = { ...snapshot };
  delete copy.observedAt;
  return JSON.stringify(copy);
}

/**
 * 订阅一个 agent 的会话位置。cwd 优先取 provider 会话记录里的最后一条，
 * 因为 Paseo 的 agent 快照 cwd 停在创建/导入时，不会跟会话里的 cd 更新。
 * 读不到会话记录时回退到 agent 快照。
 */
export async function watchAgentLocation(
  { agentId }: LocationSubscriptionInput,
  { paseo, push, signal }: PluginSubscriptionContext<LocationSubscriptionEvent>,
): Promise<void> {
  let workspaces: Map<string, PaseoWorkspace> | null = null;
  let transcript: SessionTranscript | null = null;
  let transcriptSessionId: string | null = null;
  let transcriptWatcher: FSWatcher | null = null;
  let transcriptTimer: ReturnType<typeof setTimeout> | null = null;
  let transcriptReadErrorLogged = false;
  let latestAgent: PaseoAgent | null = null;

  const loadWorkspaces = async (): Promise<Map<string, PaseoWorkspace>> => {
    if (workspaces) return workspaces;
    try {
      const map = new Map<string, PaseoWorkspace>();
      // workspace 列表按页返回，超过 200 个时后面的页要主动补齐
      let cursor: string | null = null;
      do {
        const result: PaseoWorkspaceListResult = await paseo.workspaces.list(
          cursor ? { page: { limit: 200, cursor } } : { page: { limit: 200 } },
        );
        for (const workspace of result.entries) map.set(workspace.id, workspace);
        cursor = result.pageInfo.hasMore ? (result.pageInfo.nextCursor ?? null) : null;
      } while (cursor);
      workspaces = map;
    } catch (error) {
      // 标题和相对路径折叠都依赖 workspace 列表；失败时不缓存空结果，下次 publish 重试
      console.error(`[session-location] 读取 workspace 列表失败`, errorMessage(error));
      return new Map();
    }
    return workspaces;
  };

  const buildSnapshot = async (agent: PaseoAgent): Promise<LocationSnapshot> => {
    let workspaceTitle: string | null = null;
    let workspaceDirectory: string | null = null;
    if (agent.workspaceId) {
      const workspace = (await loadWorkspaces()).get(agent.workspaceId);
      workspaceTitle = workspace?.title ?? workspace?.name ?? null;
      workspaceDirectory = workspace?.workspaceDirectory ?? workspace?.projectRootPath ?? null;
    }

    let sessionCwd: string | null = null;
    if (transcript) {
      try {
        sessionCwd = await transcript.readCwd();
      } catch (error) {
        if (!transcriptReadErrorLogged && !signal.aborted) {
          transcriptReadErrorLogged = true;
          console.error(`[session-location] 读取会话记录失败`, errorMessage(error));
        }
      }
    }

    return {
      agentId: agent.id,
      cwd: sessionCwd ?? agent.cwd,
      cwdSource: sessionCwd ? "session" : "snapshot",
      agentTitle: agent.title,
      workspaceTitle,
      workspaceDirectory,
      observedAt: new Date().toISOString(),
    };
  };

  let lastSignature: string | null = null;
  // 串行处理更新，避免异步读 workspace / transcript 后乱序推送旧值
  let chain = Promise.resolve();

  const publish = (agent: PaseoAgent): void => {
    latestAgent = agent;
    chain = chain
      .then(async () => {
        if (signal.aborted) return;
        await ensureTranscript(agent);
        const snapshot = await buildSnapshot(agent);
        const signature = signatureOf(snapshot);
        if (signature === lastSignature) return;
        lastSignature = signature;
        await push(snapshot);
      })
      .catch((error: unknown) => {
        if (!signal.aborted) console.error("[session-location] 推送会话位置失败", error);
      });
  };

  const schedulePublish = (): void => {
    // 文件追加会连续触发多次事件，合并成一次读取
    if (transcriptTimer) clearTimeout(transcriptTimer);
    transcriptTimer = setTimeout(() => {
      transcriptTimer = null;
      if (latestAgent) publish(latestAgent);
    }, 150);
  };

  const sessionIdOf = (agent: PaseoAgent): string | null =>
    agent.persistence?.sessionId ?? agent.runtimeInfo?.sessionId ?? null;

  const ensureTranscript = async (agent: PaseoAgent): Promise<void> => {
    const sessionId = sessionIdOf(agent);
    // rewind 会在同一个 agent 上换出新的 Claude session，旧 transcript 必须弃用；
    // 快照偶尔缺少 sessionId 时保留现有 transcript
    if (transcript && (sessionId === null || sessionId === transcriptSessionId)) return;

    stopTranscriptWatch();
    transcript = null;
    transcriptSessionId = null;

    const found = await openSessionTranscript(agent);
    // 查找期间订阅可能已经结束，此时不能再创建 watcher
    if (signal.aborted || !found) return;

    transcript = found;
    transcriptSessionId = sessionId;
    try {
      transcriptWatcher = watch(found.path, { persistent: false }, () => schedulePublish());
      transcriptWatcher.on("error", (error) => {
        if (!signal.aborted) {
          console.error(`[session-location] 监听会话记录失败`, errorMessage(error));
        }
        transcriptWatcher?.close();
        transcriptWatcher = null;
        // 文件被替换或删除后下次更新时重新查找
        transcript = null;
        transcriptSessionId = null;
      });
    } catch (error) {
      if (!signal.aborted) {
        console.error(`[session-location] 监听会话记录失败`, errorMessage(error));
      }
    }
  };

  const stopTranscriptWatch = (): void => {
    transcriptWatcher?.close();
    transcriptWatcher = null;
    if (transcriptTimer) {
      clearTimeout(transcriptTimer);
      transcriptTimer = null;
    }
  };

  const findAgent = (entries: readonly { agent: PaseoAgent }[]): PaseoAgent | null =>
    entries.find((entry) => entry.agent.id === agentId)?.agent ?? null;

  const observation = await paseo.agents.list({ subscribe: {}, signal });
  const initial = findAgent(observation.entries);
  if (initial) {
    publish(initial);
  } else {
    try {
      const refreshed = await paseo.agents.ref(agentId).refresh();
      if (refreshed?.agent) publish(refreshed.agent);
    } catch (error) {
      if (!signal.aborted) {
        console.error(`[session-location] 读取 agent ${agentId} 快照失败`, errorMessage(error));
      }
    }
  }

  observation.subscription.subscribe({
    snapshot: ({ entries }) => {
      const agent = findAgent(entries);
      if (agent) publish(agent);
    },
    update: (message) => {
      if (message.type !== "agent_update") return;
      const update = message.payload;
      if (update.kind === "upsert" && update.agent.id === agentId) publish(update.agent);
    },
    error: (error) => {
      if (!signal.aborted) {
        console.error(`[session-location] agent ${agentId} 更新订阅失败`, errorMessage(error));
      }
    },
  });

  // 订阅要保持在 signal abort 之前不结束；handler 的 promise resolve 会关闭订阅
  await new Promise<void>((resolve) => {
    if (signal.aborted) {
      stopTranscriptWatch();
      resolve();
      return;
    }
    signal.addEventListener(
      "abort",
      () => {
        stopTranscriptWatch();
        resolve();
      },
      { once: true },
    );
  });
}
