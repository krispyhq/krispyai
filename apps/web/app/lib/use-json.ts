"use client";

import { useCallback, useEffect, useState } from "react";

interface JsonState<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  reload: () => void;
}

/** Tiny fetch-JSON hook for the dashboard's same-origin /api/* calls. One place so
 *  every page's loading / error / reload story is identical. `url = null` → idle. */
export function useJson<T>(url: string | null): JsonState<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    if (!url) {
      setLoading(false);
      return;
    }
    setLoading(true);
    fetch(url, { credentials: "include" })
      .then(async (r): Promise<T> => {
        const body = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(body?.error || `HTTP ${r.status}`);
        return body;
      })
      .then((d) => {
        setData(d);
        setError(null);
      })
      .catch((e: Error) => setError(e.message))
      .finally(() => setLoading(false));
  }, [url]);

  useEffect(reload, [reload]);
  return { data, error, loading, reload };
}
