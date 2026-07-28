// Minimal Cloudflare Workers runtime types — only the surface this service uses.
// Hand-declared instead of depending on @cloudflare/workers-types so the edge
// service typechecks self-contained (no extra dep, no lockfile churn). If you
// later add @cloudflare/workers-types, delete this file — the real types supersede.
export {};

declare global {
  interface KVNamespace {
    get(key: string): Promise<string | null>;
    // `metadata` rides ALONGSIDE the value and — the load-bearing part — comes back in
    // list() for free. That's what lets the topic sweep read every session's last
    // activity in one paginated list instead of one read (or one DO call) per session.
    // Cloudflare caps serialized metadata at 1024 bytes; ours is two small numbers.
    put(
      key: string,
      value: string,
      opts?: { expirationTtl?: number; metadata?: unknown },
    ): Promise<void>;
    getWithMetadata<M = unknown>(
      key: string,
    ): Promise<{ value: string | null; metadata: M | null }>;
    list<M = unknown>(opts?: {
      prefix?: string;
      cursor?: string;
      limit?: number;
    }): Promise<{
      keys: { name: string; expiration?: number; metadata?: M }[];
      list_complete: boolean;
      cursor?: string;
    }>;
  }

  interface DurableObjectId {
    readonly name?: string;
  }
  interface DurableObjectStub {
    fetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>;
  }
  interface DurableObjectNamespace {
    idFromName(name: string): DurableObjectId;
    get(id: DurableObjectId): DurableObjectStub;
  }
  interface DurableObjectStorage {
    get<T = unknown>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
    // DO alarm API (one alarm per object; setAlarm overwrites the pending one).
    setAlarm(scheduledTime: number | Date): Promise<void>;
    deleteAlarm(): Promise<void>;
    getAlarm(): Promise<number | null>;
  }
  interface DurableObjectState {
    acceptWebSocket(ws: WebSocket, tags?: string[]): void;
    getWebSockets(tag?: string): WebSocket[];
    readonly storage: DurableObjectStorage;
  }

  // Cron Trigger entrypoint (`scheduled`) — the only thing that runs with no request.
  interface ScheduledController {
    readonly scheduledTime: number;
    readonly cron: string;
  }
  interface ExecutionContext {
    waitUntil(promise: Promise<unknown>): void;
  }

  // Workers AI binding.
  interface Ai {
    run(model: string, input: unknown): Promise<unknown>;
  }

  // Server end of a CF WebSocket pair. `new Response(null, { webSocket })` returns
  // the client end to the browser (status 101).
  class WebSocketPair {
    0: WebSocket;
    1: WebSocket;
  }
  interface ResponseInit {
    webSocket?: WebSocket | null;
  }
}
