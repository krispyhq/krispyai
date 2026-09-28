import { describe, expect, test } from "bun:test";
import {
  IMAGE_MAX_BYTES,
  VIDEO_MAX_BYTES,
  mediaObjectKey,
  parseMediaRange,
  validateMedia,
} from "../src/media";

const file = (bytes: number[], type: string, name = "clip") =>
  new File([new Uint8Array(bytes)], name, { type });

describe("private media guards", () => {
  test("accepts real JPEG, MP4, and WebM signatures", async () => {
    expect((await validateMedia(file([0xff, 0xd8, 0xff, 0xe0], "image/jpeg"))).ok).toBe(true);
    expect((await validateMedia(file([0, 0, 0, 20, 0x66, 0x74, 0x79, 0x70], "video/mp4"))).ok).toBe(
      true,
    );
    expect((await validateMedia(file([0x1a, 0x45, 0xdf, 0xa3], "video/webm"))).ok).toBe(true);
  });

  test("rejects HTML disguised as media, RIFF without WEBP, empty and oversize files", async () => {
    expect((await validateMedia(file([60, 104, 116, 109, 108], "image/png"))).ok).toBe(false);
    expect(
      (await validateMedia(file([82, 73, 70, 70, 0, 0, 0, 0, 87, 65, 86, 69], "image/webp"))).ok,
    ).toBe(false);
    expect((await validateMedia(file([], "video/mp4"))).ok).toBe(false);
    expect(
      await validateMedia(
        new File([new Uint8Array(VIDEO_MAX_BYTES + 1)], "large.mp4", { type: "video/mp4" }),
      ),
    ).toEqual({ ok: false, error: "too_large", maxBytes: VIDEO_MAX_BYTES });
    expect(IMAGE_MAX_BYTES).toBeLessThan(VIDEO_MAX_BYTES);
  });

  test("object keys scope IDs and ranges cannot escape an object", () => {
    expect(mediaObjectKey("tenant/a", "session:b", "id")).toBe("media/tenant%2Fa/session%3Ab/id");
    expect(parseMediaRange("bytes=4-7", 10)).toEqual({ offset: 4, length: 4 });
    expect(parseMediaRange("bytes=-3", 10)).toEqual({ offset: 7, length: 3 });
    expect(parseMediaRange("bytes=999-", 10)).toBe("invalid");
    expect(parseMediaRange("bytes=0-1,3-4", 10)).toBe("invalid");
  });
});
