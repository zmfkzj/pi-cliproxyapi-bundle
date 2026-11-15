/**
 * Source overlay of pi-cliproxyapi-provider: a repository-owned fix of upstream files, applied without editing the
 * installed npm package. The bundle copies the installed provider package once into `<bundle>/.provider-overlay/<key>/`
 * (generated, ignored by git), replaces the files listed in `overlay/manifest.json` with the patched copies under
 * `overlay/pi-cliproxyapi-provider/`, and loads the provider's extension entry from that copy.
 *
 * Guard: every replaced file must still hash to the `upstreamSha256` it was written for. When an update changes such a
 * file, the overlay is skipped (the unmodified provider loads, and the bundle doctor reports the skip) instead of
 * replacing newer upstream code with an old copy. See overlay/README.md for the update procedure.
 */
import { createHash, randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** This package's directory (src/..). */
const BUNDLE_DIR = fileURLToPath(new URL("..", import.meta.url));
/** The tracked overlay sources: `manifest.json` and the patched files under `<package>/`. */
export const OVERLAY_SOURCE_DIR = join(BUNDLE_DIR, "overlay");
/** Where the patched copies are generated. */
export const OVERLAY_TARGET_ROOT = join(BUNDLE_DIR, ".provider-overlay");
const STAMP = ".overlay.json";

export interface OverlayManifest {
  package: string;
  writtenFor?: string;
  files: Record<string, { upstreamSha256: string; change?: string }>;
}

export type OverlayResult =
  | { status: "applied"; dir: string; detail: string }
  | { status: "skipped"; detail: string };

export interface PrepareOverlayOptions {
  /** The installed provider package directory (its package.json). */
  providerDir: string;
  /** Default: OVERLAY_SOURCE_DIR. */
  sourceDir?: string;
  /** Default: OVERLAY_TARGET_ROOT. */
  targetRoot?: string;
}

const sha256 = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

export function readOverlayManifest(sourceDir = OVERLAY_SOURCE_DIR): OverlayManifest {
  const manifest = JSON.parse(readFileSync(join(sourceDir, "manifest.json"), "utf8")) as OverlayManifest;
  if (!manifest || typeof manifest.package !== "string" || !manifest.files || typeof manifest.files !== "object") {
    throw new Error(`invalid overlay manifest: ${join(sourceDir, "manifest.json")}`);
  }
  return manifest;
}

/** Files whose installed upstream copy no longer hashes to the version the overlay was written for. */
export function changedUpstreamFiles(providerDir: string, manifest: OverlayManifest): string[] {
  return Object.entries(manifest.files)
    .filter(([file, entry]) => {
      const path = join(providerDir, file);
      return !existsSync(path) || sha256(readFileSync(path)) !== entry.upstreamSha256;
    })
    .map(([file]) => file);
}

function stampMatches(dir: string, key: string): boolean {
  try { return (JSON.parse(readFileSync(join(dir, STAMP), "utf8")) as { key?: unknown }).key === key; } catch { return false; }
}

/**
 * Prepare (or reuse) the patched copy of the installed provider. Never throws: any failure returns `skipped` with the
 * reason, and the caller loads the unmodified provider.
 */
export function prepareProviderOverlay(options: PrepareOverlayOptions): OverlayResult {
  const sourceDir = options.sourceDir ?? OVERLAY_SOURCE_DIR;
  const targetRoot = options.targetRoot ?? OVERLAY_TARGET_ROOT;
  try {
    const manifest = readOverlayManifest(sourceDir);
    const pkg = JSON.parse(readFileSync(join(options.providerDir, "package.json"), "utf8")) as { name?: unknown; version?: unknown };
    if (pkg.name !== manifest.package) return { status: "skipped", detail: `${options.providerDir} is not ${manifest.package}` };
    const version = typeof pkg.version === "string" ? pkg.version : "unknown";
    const files = Object.keys(manifest.files);
    const changed = changedUpstreamFiles(options.providerDir, manifest);
    if (changed.length) {
      return { status: "skipped", detail: `${manifest.package} ${version} changed ${changed.join(", ")} since the overlay was written`
        + `${manifest.writtenFor ? ` for ${manifest.writtenFor}` : ""}; the unmodified provider is loaded` };
    }
    const patched = files.map(file => [file, readFileSync(join(sourceDir, manifest.package, file))] as const);
    const key = `${version}-${sha256(Buffer.concat(patched.flatMap(([file, data]) => [Buffer.from(`${file}\n`), data]))).slice(0, 12)}`;
    const dir = join(targetRoot, key);
    const detail = `${manifest.package} ${version} with ${files.join(", ")} from overlay/`;
    if (stampMatches(dir, key)) return { status: "applied", dir, detail };

    mkdirSync(targetRoot, { recursive: true });
    const tmp = join(targetRoot, `.tmp-${process.pid}-${randomBytes(4).toString("hex")}`);
    try {
      cpSync(options.providerDir, tmp, { recursive: true, filter: source => basename(source) !== "node_modules" });
      for (const [file, data] of patched) {
        mkdirSync(dirname(join(tmp, file)), { recursive: true });
        writeFileSync(join(tmp, file), data);
      }
      writeFileSync(join(tmp, STAMP), `${JSON.stringify({ key, package: manifest.package, version, files }, null, 2)}\n`);
      if (stampMatches(dir, key)) {
        // Another process published the same copy meanwhile; keep it (it may be loading from it).
        rmSync(tmp, { recursive: true, force: true });
      } else {
        if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
        renameSync(tmp, dir);
      }
    } catch (error) {
      rmSync(tmp, { recursive: true, force: true });
      // Another process may have published the same copy in the meantime.
      if (!stampMatches(dir, key)) throw error;
    }
    // Copies for other versions are left by earlier installs; remove them once they are a day old, so a Pi process still
    // running an older version keeps its files.
    const dayAgo = Date.now() - 86_400_000;
    for (const entry of readdirSync(targetRoot)) {
      if (entry === key) continue;
      try {
        if (statSync(join(targetRoot, entry)).mtimeMs < dayAgo) rmSync(join(targetRoot, entry), { recursive: true, force: true });
      } catch { /* best effort */ }
    }
    return { status: "applied", dir, detail };
  } catch (error) {
    return { status: "skipped", detail: `the overlay could not be prepared: ${error instanceof Error ? error.message : String(error)}` };
  }
}
