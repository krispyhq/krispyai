import { expect, test } from "bun:test";
import worker from "../src/index";
import { SessionDO } from "../src/session-do";
import type { Env } from "../src/types";

function harness() {
  const objects = new Map<string, SessionDO>();
  const blobs = new Map<string, { bytes: Uint8Array; customMetadata: Record<string, string> }>();
  const kv = new Map<string, string>();
  const env = {
    DO_INTERNAL_SECRET: "media-http-test",
    TENANT_SYNC_SECRET: "operator-test-secret",
    KRISPY_KV: {
      get: async (key: string) => kv.get(key) ?? null,
      put: async (key: string, value: string) => {
        kv.set(key, value);
      },
    },
    MEDIA: {
      head: async (key: string) => {
        const object = blobs.get(key);
        return object ? { size: object.bytes.length, customMetadata: object.customMetadata } : null;
      },
      put: async (
        key: string,
        body: ReadableStream<Uint8Array>,
        options: { customMetadata: Record<string, string> },
      ) => {
        if (blobs.has(key)) return null;
        blobs.set(key, {
          bytes: new Uint8Array(await new Response(body).arrayBuffer()),
          customMetadata: options.customMetadata,
        });
        return {};
      },
      get: async (key: string, options?: { range?: { offset: number; length: number } }) => {
        const object = blobs.get(key);
        if (!object) return null;
        const bytes = options?.range
          ? object.bytes.slice(options.range.offset, options.range.offset + options.range.length)
          : object.bytes;
        return {
          body: new Blob([bytes.slice().buffer as ArrayBuffer]).stream(),
          size: object.bytes.length,
        };
      },
    },
    SESSION: {
      idFromName: (name: string) => name,
      get: (name: string) => ({
        fetch: (input: RequestInfo | URL, init?: RequestInit) => {
          let object = objects.get(name);
          if (!object) {
            const data = new Map<string, unknown>();
            const state = {
              storage: {
                get: async (key: string) => data.get(key),
                put: async (key: string, value: unknown) => {
                  data.set(key, value);
                },
                transaction: async (run: (tx: DurableObjectStorage) => Promise<unknown>) =>
                  run(state.storage),
                list: async () => new Map(),
                setAlarm: async () => {},
                deleteAlarm: async () => {},
                getAlarm: async () => null,
              },
              getWebSockets: () => [],
            } as unknown as DurableObjectState;
            object = new SessionDO(state, env as Env);
            objects.set(name, object);
          }
          return object.fetch(input instanceof Request ? input : new Request(input, init));
        },
      }),
    },
  } as unknown as Env;
  const request = (path: string, init?: RequestInit) =>
    worker.fetch(new Request(`https://edge.example.test${path}`, init), env);
  return { request, blobs };
}

test("visitor image is private, durable, idempotent, and range-readable", async () => {
  const h = harness();
  const id = "77777777-7777-4777-8777-777777777777";
  const secret = "s".repeat(43);
  const form = new FormData();
  form.set("tenantId", "self");
  form.set("sessionId", "media-http-session");
  form.set("visitorSecret", secret);
  form.set("uploadId", id);
  form.set("caption", "Here is the screenshot");
  form.set(
    "file",
    new File([new Uint8Array([0xff, 0xd8, 0xff, 0xe0])], "proof.jpg", { type: "image/jpeg" }),
  );
  const upload = await h.request("/api/media/visitor", { method: "POST", body: form });
  expect(upload.status).toBe(200);
  expect((await upload.json()).recorded).toBe(true);
  expect(h.blobs.size).toBe(1);
  const path = `/api/media/${id}?t=self&s=media-http-session`;
  expect((await h.request(path)).status).toBe(401);
  expect((await h.request(path, { headers: { "x-visitor-secret": "x".repeat(43) } })).status).toBe(
    403,
  );
  const guestHead = await h.request(path, {
    method: "HEAD",
    headers: { "x-visitor-secret": secret, Origin: "https://guest.example.test" },
  });
  expect(guestHead.status).toBe(200);
  expect(guestHead.headers.get("access-control-allow-origin")).toBe("*");
  expect(guestHead.headers.get("content-length")).toBe("4");
  const media = await h.request(path, {
    headers: {
      "x-visitor-secret": secret,
      Range: "bytes=1-2",
      Origin: "https://guest.example.test",
    },
  });
  expect(media.status).toBe(206);
  expect(media.headers.get("access-control-allow-origin")).toBe("*");
  expect(media.headers.get("Content-Range")).toBe("bytes 1-2/4");
  expect([...new Uint8Array(await media.arrayBuffer())]).toEqual([0xd8, 0xff]);
  const operator = await h.request(path, {
    headers: { "x-tenant-sync-secret": "operator-test-secret" },
  });
  expect(operator.status).toBe(200);
  expect(operator.headers.get("Content-Type")).toBe("image/jpeg");

  const videoId = "88888888-8888-4888-8888-888888888888";
  const outbound = new FormData();
  outbound.set("tenantId", "self");
  outbound.set("sessionId", "media-http-session");
  outbound.set("uploadId", videoId);
  outbound.set("caption", "Here is a short clip");
  outbound.set(
    "file",
    new File([new Uint8Array([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70])], "answer.mp4", {
      type: "video/mp4",
    }),
  );
  expect((await h.request("/api/operator/media", { method: "POST", body: outbound })).status).toBe(
    401,
  );
  const outboundReply = await h.request("/api/operator/media", {
    method: "POST",
    headers: { "x-tenant-sync-secret": "operator-test-secret" },
    body: outbound,
  });
  expect(outboundReply.status).toBe(200);
  expect((await outboundReply.json()).media.kind).toBe("video");
  const visitorVideo = await h.request(`/api/media/${videoId}?t=self&s=media-http-session`, {
    headers: { "x-visitor-secret": secret },
  });
  expect(visitorVideo.status).toBe(200);
  expect(visitorVideo.headers.get("Content-Type")).toBe("video/mp4");
});
