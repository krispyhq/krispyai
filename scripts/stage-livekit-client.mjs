// Stage the pinned browser UMD. The widget loads it only when a visitor accepts
// an audio call; no livekit-client code enters the widget's runtime bundle.
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const packageDir = process.argv[2];
const version = "2.22.3";
const expectedSha256 = "7fa17e37af5e996d8a25f15a637dcc0620215bc01b394e5d209f726afe7dc04d";
const temp = packageDir ? null : mkdtempSync(join(tmpdir(), "krispy-livekit-"));
let source;
try {
  if (packageDir) {
    source = resolve(packageDir);
  } else {
    const archive = execFileSync(
      "npm",
      [
        "pack",
        `livekit-client@${version}`,
        "--pack-destination",
        temp,
        "--silent",
        "--ignore-scripts",
      ],
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    ).trim();
    execFileSync(
      "tar",
      [
        "-xzf",
        join(temp, archive),
        "-C",
        temp,
        "package/package.json",
        "package/dist/livekit-client.umd.js",
        "package/LICENSE",
      ],
      { stdio: "ignore" },
    );
    source = join(temp, "package");
  }
  const manifest = JSON.parse(readFileSync(resolve(source, "package.json"), "utf8"));
  if (manifest.name !== "livekit-client" || manifest.version !== version) {
    throw new Error(`expected livekit-client@${version} at ${source}`);
  }

  const bundle = resolve(source, "dist/livekit-client.umd.js");
  const license = resolve(source, "LICENSE");
  const digest = createHash("sha256").update(readFileSync(bundle)).digest("hex");
  if (digest !== expectedSha256) throw new Error(`livekit-client@${version} UMD checksum mismatch`);
  const outDir = resolve("packages/widget/vendor");
  mkdirSync(outDir, { recursive: true });
  const fileName = `livekit-client-v${version}.umd.js`;
  copyFileSync(bundle, resolve(outDir, fileName));
  copyFileSync(license, resolve(outDir, `LICENSE.livekit-client-v${version}.txt`));
  console.log(`✔ staged ${fileName} (${digest}) with its Apache-2.0 license`);
} finally {
  if (temp) rmSync(temp, { recursive: true, force: true });
}
