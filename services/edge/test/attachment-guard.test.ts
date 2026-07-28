// The screenshot upload is a PUBLIC, UNAUTHENTICATED endpoint that forwards bytes to
// Telegram. Its guards are the feature, so they get the test. Run: `bun test`.
import { expect, test, describe } from "bun:test";
import { looksLikeImage, ATTACH_TYPES, ATTACH_MAX_BYTES } from "../src/index";

const head = (...bytes: number[]) => new Uint8Array([...bytes, ...Array(12).fill(0)]);

const PNG = head(0x89, 0x50, 0x4e, 0x47);
const JPEG = head(0xff, 0xd8, 0xff);
const WEBP = head(0x52, 0x49, 0x46, 0x46);
const GIF = head(0x47, 0x49, 0x46, 0x38);

describe("attachment type guard", () => {
  test("accepts the four image formats by their magic bytes", () => {
    expect(looksLikeImage("image/png", PNG)).toBe(true);
    expect(looksLikeImage("image/jpeg", JPEG)).toBe(true);
    expect(looksLikeImage("image/webp", WEBP)).toBe(true);
    expect(looksLikeImage("image/gif", GIF)).toBe(true);
  });

  test("a DECLARED content-type is not enough — the bytes must agree", () => {
    // The whole point: `file.type` is a claim by the caller. An HTML file, a shell
    // script or a PDF renamed to .png and declared image/png must not pass.
    const html = head(0x3c, 0x21, 0x44, 0x4f); // "<!DO"
    const shell = head(0x23, 0x21, 0x2f, 0x62); // "#!/b"
    const pdf = head(0x25, 0x50, 0x44, 0x46); // "%PDF"
    const elf = head(0x7f, 0x45, 0x4c, 0x46); // ELF binary
    for (const bytes of [html, shell, pdf, elf]) {
      expect(looksLikeImage("image/png", bytes)).toBe(false);
      expect(looksLikeImage("image/jpeg", bytes)).toBe(false);
    }
  });

  test("real image bytes under the WRONG declared type are still refused", () => {
    // Mismatched pairs: the allowlist is keyed by declared type, and the magic
    // bytes must match THAT entry — not merely be some image.
    expect(looksLikeImage("image/jpeg", PNG)).toBe(false);
    expect(looksLikeImage("image/png", JPEG)).toBe(false);
    expect(looksLikeImage("image/gif", WEBP)).toBe(false);
  });

  test("a type outside the allowlist is refused however plausible", () => {
    expect(looksLikeImage("image/svg+xml", head(0x3c, 0x73, 0x76, 0x67))).toBe(false);
    expect(looksLikeImage("application/pdf", head(0x25, 0x50, 0x44, 0x46))).toBe(false);
    expect(looksLikeImage("", PNG)).toBe(false);
    expect(looksLikeImage("image/png ", PNG)).toBe(false); // no trimming, no coercion
  });

  test("SVG is deliberately NOT allowed", () => {
    // An SVG is a document that can carry <script>. It is an image only by MIME.
    expect(Object.keys(ATTACH_TYPES)).not.toContain("image/svg+xml");
  });

  test("the size cap stays under Telegram's own sendPhoto ceiling", () => {
    expect(ATTACH_MAX_BYTES).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(ATTACH_MAX_BYTES).toBeGreaterThan(0);
  });

  test("a truncated head cannot pass", () => {
    expect(looksLikeImage("image/png", new Uint8Array([0x89, 0x50]))).toBe(false);
    expect(looksLikeImage("image/png", new Uint8Array([]))).toBe(false);
  });
});
