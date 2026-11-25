import { useRpc } from "@getpaseo/plugin/client";
import { useEffect, useRef, useState } from "react";
import { statsRpc, type StatsOutput } from "../shared/protocol";
import { localDay } from "./time";

export interface StatsState {
  data: StatsOutput | null;
  error: string | null;
  loading: boolean;
}

const POLL_MS = 60_000;

/** 屏幕和侧边栏共用；定时刷新，period/refreshKey 变化时立即重查 */
export function useStats(period: 7 | 30, refreshKey = 0): StatsState {
  const rpc = useRpc(statsRpc);
  const rpcRef = useRef(rpc);
  useEffect(() => {
    rpcRef.current = rpc;
  }, [rpc]);

  const [data, setData] = useState<StatsOutput | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    const load = async (): Promise<void> => {
      try {
        const result = await rpcRef.current({
          days: period,
          today: localDay(),
        });
        if (!alive) return;
        setData(result);
        setError(null);
      } catch (caught) {
        if (!alive) return;
        setError(caught instanceof Error ? caught.message : String(caught));
      } finally {
        if (alive) setLoading(false);
      }
    };

    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [period, refreshKey]);

  return { data, error, loading };
}
