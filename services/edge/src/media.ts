import type { SessionMedia } from "./types";

// Keep uploads small enough for one Worker request and a short support clip.
// The widget receives these limits from /api/widget/config.
export const IMAGE_MAX_BYTES = 10 * 1024 * 1024;
export const VIDEO_MAX_BYTES = 30 * 1024 * 1024;
export const MEDIA_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const IMAGE_MAGIC: Record<string, number[]> = {
  "image/png": [0x89, 0x50, 0x4e, 0x47],
  "image/jpeg": [0xff, 0xd8, 0xff],
  "image/webp": [0x52, 0x49, 0x46, 0x46],
  "image/gif": [0x47, 0x49, 0x46, 0x38],
};

export type MediaValidation =
  | { ok: true; kind: SessionMedia["kind"]; contentType: string; name: string }
  | { ok: false; error: "unsupported_type" | "too_large" | "empty_file"; maxBytes?: number };

/** MIME is a caller claim: check the file signature before storing or serving it. */
export async function validateMedia(file: File): Promise<MediaValidation> {
  const contentType = file.type.toLowerCase();
  const kind = contentType.startsWith("image/") ? "image" : "video";
  const maxBytes = kind === "image" ? IMAGE_MAX_BYTES : VIDEO_MAX_BYTES;
  if (file.size === 0) return { ok: false, error: "empty_file" };
  if (file.size > maxBytes) return { ok: false, error: "too_large", maxBytes };
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
  let valid = false;
  const magic = IMAGE_MAGIC[contentType];
  if (magic) {
    valid = magic.every((byte, index) => head[index] === byte);
    if (contentType === "image/webp")
      valid &&= [0x57, 0x45, 0x42, 0x50].every((byte, index) => head[index + 8] === byte);
  } else if (contentType === "video/mp4" || contentType === "video/quicktime") {
    valid = [0x66, 0x74, 0x79, 0x70].every((byte, index) => head[index + 4] === byte);
  } else if (contentType === "video/webm") {
    valid = [0x1a, 0x45, 0xdf, 0xa3].every((byte, index) => head[index] === byte);
  }
  if (!valid) return { ok: false, error: "unsupported_type" };
  return {
    ok: true,
    kind,
    contentType,
    name: Array.from(file.name || (kind === "image" ? "image" : "video"))
      .map((character) =>
        character === "/" ||
        character === "\\" ||
        character.charCodeAt(0) < 32 ||
        character.charCodeAt(0) === 127
          ? "_"
          : character,
      )
      .join("")
      .slice(0, 120),
  };
}

export function mediaObjectKey(tenantId: string, sessionId: string, mediaId: string): string {
  return `media/${encodeURIComponent(tenantId)}/${encodeURIComponent(sessionId)}/${mediaId}`;
}

/** One HTTP byte range. Multiple ranges are deliberately unsupported. */
export function parseMediaRange(
  header: string | null,
  size: number,
): { offset: number; length: number } | null | "invalid" {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header);
  if (!match || (!match[1] && !match[2])) return "invalid";
  if (!match[1]) {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix <= 0) return "invalid";
    return { offset: Math.max(0, size - suffix), length: Math.min(size, suffix) };
  }
  const offset = Number(match[1]);
  const end = match[2] ? Number(match[2]) : size - 1;
  if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(end) || offset >= size || end < offset)
    return "invalid";
  return { offset, length: Math.min(end, size - 1) - offset + 1 };
}
