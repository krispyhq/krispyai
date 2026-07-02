"use client";

export interface TenantPatch {
  botToken?: string;
  chatId?: string;
  systemPrompt?: string;
  model?: string;
}

export interface SaveResult {
  ok: boolean;
  pending?: boolean;
  error?: string;
}

/** POST a partial tenant-config to the app's proxy (which forwards to the edge). */
export async function saveTenant(patch: TenantPatch): Promise<SaveResult> {
  return fetch("/api/tenant", {
    method: "POST",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  })
    .then((r) => r.json())
    .catch(() => ({ ok: false, error: "That didn't send — mind trying again?" }));
}
