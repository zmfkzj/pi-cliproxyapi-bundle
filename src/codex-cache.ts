/**
 * Protects the upstream provider's patched Codex module from its shared, non-atomic file cache.
 *
 * The provider (`@router-for-me/pi-cliproxyapi-provider` 1.4.24, `extensions/codex-stream.ts`, `loadCliproxyCodexStreams`)
 * patches Pi AI's Codex responses module and imports the result from
 * `<tmpdir>/pi-cliproxyapi-provider/openai-codex-responses-cpa-<hash>.mjs`. It writes that file only when it does not exist,
 * in place (`writeFileSync`: create/truncate, then write), and imports it whenever it exists. Any process running that code
 * (an older bundle, a separate install of the provider, several Pi processes starting together) can therefore truncate the
 * file while another imports it, and a process killed while writing leaves a broken file for every later start. The
 * provider then only warns ("failed to load patched codex protocol") and every `cliproxyapi` request of that session fails.
 *
 * The bundle therefore does not let its provider read that file at all. Before the provider loads, it computes the same
 * path and source with the provider's own exported functions and registers Node module hooks (`module.registerHooks`) that
 * answer the import of exactly that URL with the computed source from memory. What other processes do to the file cannot
 * reach this process's module. It also publishes the file atomically (verified contents, same-directory temporary file,
 * flush, rename), so the provider finds it and does not write it in place itself, and processes without this protection
 * see a complete file where they can.
 *
 * Any other patched-module import from that cache (the source could not be computed, or the provider computed a different
 * path) is refused instead of read unprotected: Codex streaming of the provider fails with the reason, its other features stay.
 * Without `module.registerHooks` (runtimes other than Node >= 22.15) protection is impossible and `protectCodexModule` throws.
 */
import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import * as nodeModule from "node:module";
import { basename, dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

export const PROVIDER_PACKAGE = "@router-for-me/pi-cliproxyapi-provider";
/** Temporary files older than this belong to a process that died before its rename (a write takes milliseconds). */
export const STALE_TEMP_MS = 10 * 60_000;

/** The provider's exported functions that define the cache path and contents. */
export interface CodexCacheApi {
  resolveOriginalCodexModulePath(): { path: string };
  sharedSupportsConfigurationUpdate(sharedSource: string): boolean;
  patchCodexSource(source: string, providerIds: string[], options: { supportsConfigurationUpdate?: boolean }): string;
  computePatchedModuleCachePath(originalPath: string, patchedSource: string): string;
  rewritePatchedModuleImports(source: string, originalPath: string): string;
  resolveIdentity(agentDir: string): { providerId: string };
}

const REQUIRED = ["resolveOriginalCodexModulePath", "sharedSupportsConfigurationUpdate", "patchCodexSource",
  "computePatchedModuleCachePath", "rewritePatchedModuleImports", "resolveIdentity"] as const;

/** The provider's own modules (the same instances its extension imports). Throws when an expected export is gone. */
export async function loadCodexCacheApi(): Promise<CodexCacheApi> {
  const [stream, lib] = await Promise.all([
    import(`${PROVIDER_PACKAGE}/extensions/codex-stream.ts`) as Promise<Record<string, unknown>>,
    import(`${PROVIDER_PACKAGE}/extensions/lib.ts`) as Promise<Record<string, unknown>>,
  ]);
  const api = { ...stream, ...lib } as Record<string, unknown>;
  const missing = REQUIRED.filter(name => typeof api[name] !== "function");
  if (missing.length) throw new Error(`${PROVIDER_PACKAGE} no longer exports ${missing.join(", ")}`);
  return api as unknown as CodexCacheApi;
}

/** The cache file the provider's `loadCliproxyCodexStreams` imports in this process, and its exact contents. */
export function expectedCodexCache(api: CodexCacheApi, agentDir: string): { path: string; contents: string } {
  // Mirrors loadCliproxyCodexStreams(): provider ids [identity, "cliproxyapi"] as its extension passes them.
  const { path: originalPath } = api.resolveOriginalCodexModulePath();
  const originalSource = readFileSync(originalPath, "utf8");
  let sharedSource = "";
  try { sharedSource = readFileSync(join(dirname(originalPath), "openai-responses-shared.js"), "utf8"); } catch { /* as upstream */ }
  const supportsConfigurationUpdate = api.sharedSupportsConfigurationUpdate(sharedSource);
  const patched = api.patchCodexSource(originalSource, [api.resolveIdentity(agentDir).providerId, "cliproxyapi"], { supportsConfigurationUpdate });
  return { path: api.computePatchedModuleCachePath(originalPath, patched), contents: api.rewritePatchedModuleImports(patched, originalPath) };
}

export interface PublishResult {
  path: string;
  /** valid: already complete; created: was missing; repaired: replaced incomplete or wrong contents. */
  action: "valid" | "created" | "repaired";
  /** Temporary files of processes that died before their rename, removed now. */
  removedTemps: number;
}

const tempPrefix = (target: string) => `${basename(target)}.`;
const TEMP_SUFFIX = ".tmp";

/** Removes this cache file's temporary files older than `staleMs`; younger ones may still be another process's write. */
function sweepStaleTemps(target: string, now: number, staleMs: number): number {
  let removed = 0;
  const dir = dirname(target);
  const prefix = tempPrefix(target);
  let names: string[] = [];
  try { names = readdirSync(dir); } catch { return 0; }
  for (const name of names) {
    if (!name.startsWith(prefix) || !name.endsWith(TEMP_SUFFIX)) continue;
    try {
      if (now - statSync(join(dir, name)).mtimeMs > staleMs) { rmSync(join(dir, name), { force: true }); removed++; }
    } catch { /* already gone */ }
  }
  return removed;
}

/**
 * Makes `target` hold exactly `contents`: unchanged when it already does, otherwise replaced by an atomic rename of a
 * fully written and flushed temporary file in the same directory. On failure the temporary file is removed and `target`
 * is left as it was.
 */
export function publishAtomically(target: string, contents: string, options: { now?: number; staleMs?: number } = {}): PublishResult {
  mkdirSync(dirname(target), { recursive: true });
  const removedTemps = sweepStaleTemps(target, options.now ?? Date.now(), options.staleMs ?? STALE_TEMP_MS);
  let current: string | undefined;
  try { current = readFileSync(target, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (current === contents) return { path: target, action: "valid", removedTemps };
  const temp = join(dirname(target), `${tempPrefix(target)}${process.pid}.${randomBytes(6).toString("hex")}${TEMP_SUFFIX}`);
  try {
    const fd = openSync(temp, "wx", 0o644);
    try {
      const bytes = Buffer.from(contents, "utf8");
      for (let offset = 0; offset < bytes.length;) offset += writeSync(fd, bytes, offset, bytes.length - offset);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temp, target);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return { path: target, action: current === undefined ? "created" : "repaired", removedTemps };
}

/** A patched-module file of the provider's cache: `.../pi-cliproxyapi-provider/openai-codex-responses-cpa-<16 hex>.mjs`. */
export const PATCHED_MODULE_URL = /\/pi-cliproxyapi-provider\/openai-codex-responses-cpa-[0-9a-f]{16}\.mjs$/;

type RegisterHooks = (hooks: {
  resolve?: (specifier: string, context: unknown, next: (specifier: string, context?: unknown) => unknown) => unknown;
  load?: (url: string, context: unknown, next: (url: string, context?: unknown) => unknown) => unknown;
}) => unknown;

interface ModuleSourceRegistry {
  /** file URL -> module source served instead of the file */
  served: Map<string, string>;
  /** Set while protection failed in this process: patched-module imports from the cache are refused with this reason. */
  refused?: string;
}

// One registry and one hook registration per process, shared by every load of this module: Pi re-evaluates extensions on
// /reload, and registering again each time would stack hooks. Node caches a module (or its failed import) per URL for the
// life of the process, so a refused import stays refused until Pi restarts.
const REGISTRY = Symbol.for("oh-my-pi-extensions.cliproxyapi.codex-module-source");

function toFileUrl(specifier: string): string | undefined {
  if (specifier.startsWith("file:")) return specifier;
  return isAbsolute(specifier) ? pathToFileURL(specifier).href : undefined;
}

function moduleSourceRegistry(registerHooks: RegisterHooks | undefined): ModuleSourceRegistry {
  const global = globalThis as { [REGISTRY]?: ModuleSourceRegistry };
  const existing = global[REGISTRY];
  if (existing) return existing;
  if (typeof registerHooks !== "function") {
    throw new Error(`this runtime (${process.release?.name ?? "?"} ${process.version}) has no module.registerHooks, so the provider's patched Codex module cannot be kept from its shared file cache`);
  }
  const registry: ModuleSourceRegistry = { served: new Map() };
  // Every patched-module URL of the provider's cache is answered here: served from memory, or refused. None reaches the file.
  const ours = (url: string | undefined) => url !== undefined && (registry.served.has(url) || PATCHED_MODULE_URL.test(url));
  registerHooks({
    // Resolve the served URL without looking at the file (it may be missing or being rewritten by another process).
    resolve(specifier, context, next) {
      const url = toFileUrl(specifier);
      return ours(url) ? { url, format: "module", shortCircuit: true } : next(specifier, context);
    },
    load(url, context, next) {
      const source = registry.served.get(url);
      if (source !== undefined) return { format: "module", source, shortCircuit: true };
      if (PATCHED_MODULE_URL.test(url)) {
        const why = registry.refused ?? `not the patched module this bundle prepared (${[...registry.served.keys()].join(", ") || "none"}); the provider's inputs changed between the two computations`;
        throw new Error(`[pi-cliproxyapi-bundle] refused to import ${url} from the shared cache unprotected: ${why}`);
      }
      return next(url, context);
    },
  });
  global[REGISTRY] = registry;
  return registry;
}

export interface CodexModuleProtection {
  /** true: imports of `url` get the computed source; false: patched-module imports are refused (`reason`). */
  protected: boolean;
  url?: string;
  reason?: string;
  /** The atomic publication of the shared file (best effort; the import does not depend on it). */
  publish?: PublishResult;
  publishError?: string;
}

/**
 * Prepares this process's import of the provider's patched Codex module (see the file comment). Throws only when module
 * hooks are unavailable; a failure to compute the source refuses the import and is returned as `protected: false`.
 */
export async function protectCodexModule(options: {
  agentDir: string; api?: CodexCacheApi; registerHooks?: RegisterHooks | undefined; now?: number; staleMs?: number;
}): Promise<CodexModuleProtection> {
  const registry = moduleSourceRegistry("registerHooks" in options ? options.registerHooks : (nodeModule as { registerHooks?: RegisterHooks }).registerHooks);
  let expected: { path: string; contents: string };
  try {
    expected = expectedCodexCache(options.api ?? await loadCodexCacheApi(), options.agentDir);
  } catch (error) {
    const reason = `could not compute the patched Codex module (${error instanceof Error ? error.message : String(error)})`;
    registry.refused = reason;
    return { protected: false, reason };
  }
  const url = pathToFileURL(expected.path).href;
  registry.served.set(url, expected.contents);
  registry.refused = undefined;
  try {
    return { protected: true, url, publish: publishAtomically(expected.path, expected.contents, options) };
  } catch (error) {
    return { protected: true, url, publishError: error instanceof Error ? error.message : String(error) };
  }
}
