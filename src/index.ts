/**
 * pi-cliproxyapi-bundle: loads the official CLIProxyAPI provider package (@router-for-me/pi-cliproxyapi-provider, MIT) as
 * part of oh-my-pi-extensions: its provider extension (`cliproxyapi` models, /login CLIProxyAPI, /fast, /pause, /continue,
 * /cliproxyapi-refresh) and its TUI elapsed/TPS helper, unchanged.
 *
 * When the same package is also installed on its own (a `packages` entry in Pi's settings), that install is the one Pi
 * loads and this bundle stays out of the way, so the provider, its commands and its footer never load twice.
 * `PI_CLIPROXYAPI_BUNDLED=on|off` forces either way (default `auto`).
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { getAgentDir, ProjectTrustStore, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

export const PACKAGE_NAME = "@router-for-me/pi-cliproxyapi-provider";
/** The upstream package's own `pi.extensions` entries, in its order. */
export const UPSTREAM_ENTRIES = ["extensions/index.ts", "extensions/tps.ts"] as const;

type PackageSource = string | { source?: unknown };

function readPackages(settingsFile: string): PackageSource[] {
  try {
    const packages = (JSON.parse(readFileSync(settingsFile, "utf8")) as { packages?: unknown }).packages;
    return Array.isArray(packages) ? packages as PackageSource[] : [];
  } catch { return []; }
}

function readJson(file: string): Record<string, unknown> | undefined {
  try { return JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>; } catch { return undefined; }
}

/**
 * Whether a Pi package source names the upstream package: `npm:@router-for-me/pi-cliproxyapi-provider[@version]`, a git
 * or URL source of its repository, or a local directory whose package.json has that name (relative to `baseDir`).
 */
export function isUpstreamSource(source: string, baseDir: string): boolean {
  const text = source.trim();
  if (text.startsWith("npm:")) {
    const spec = text.slice(4);
    return spec === PACKAGE_NAME || spec.startsWith(`${PACKAGE_NAME}@`);
  }
  if (/^(git:|git\+|https?:\/\/|ssh:\/\/|git@)/.test(text)) return /(^|[/:])router-for-me\/pi-cliproxyapi-provider(\.git)?(@[^/]*)?\/?$/.test(text);
  const dir = text.startsWith("~/") ? join(process.env.HOME ?? "", text.slice(2)) : isAbsolute(text) ? text : resolve(baseDir, text);
  return readJson(join(dir, "package.json"))?.name === PACKAGE_NAME;
}

/**
 * The settings files that install the upstream package on its own: the user's settings, and the project's when Pi trusts
 * that project (Pi loads project packages only then).
 */
export function separateInstalls(options: { agentDir: string; cwd: string; projectTrusted?: boolean }): string[] {
  const global = join(options.agentDir, "settings.json");
  const project = join(options.cwd, ".pi", "settings.json");
  const trusted = options.projectTrusted ?? (() => {
    try { return new ProjectTrustStore(options.agentDir).get(options.cwd) === true || readJson(global)?.defaultProjectTrust === "always"; } catch { return false; }
  })();
  return [[global, options.agentDir] as const, ...(trusted && existsSync(project) ? [[project, join(options.cwd, ".pi")] as const] : [])]
    .filter(([file, base]) => readPackages(file).some(entry => {
      const source = typeof entry === "string" ? entry : typeof entry?.source === "string" ? entry.source : undefined;
      return !!source && isUpstreamSource(source, base);
    }))
    .map(([file]) => file);
}

export type BundleMode = "auto" | "on" | "off";
export function bundleMode(value: string | undefined): BundleMode {
  const text = value?.trim().toLowerCase();
  return text === "on" || text === "off" ? text : "auto";
}

export interface BundleDecision { load: boolean; reason: string }
export function decideBundle(options: { env?: NodeJS.ProcessEnv; agentDir?: string; cwd?: string; projectTrusted?: boolean } = {}): BundleDecision {
  const env = options.env ?? process.env;
  const mode = bundleMode(env.PI_CLIPROXYAPI_BUNDLED);
  if (mode === "off") return { load: false, reason: "PI_CLIPROXYAPI_BUNDLED=off" };
  if (mode === "on") return { load: true, reason: "PI_CLIPROXYAPI_BUNDLED=on" };
  const files = separateInstalls({ agentDir: options.agentDir ?? getAgentDir(), cwd: options.cwd ?? process.cwd(), ...(options.projectTrusted !== undefined ? { projectTrusted: options.projectTrusted } : {}) });
  return files.length
    ? { load: false, reason: `${PACKAGE_NAME} is installed on its own (${files.join(", ")}); that install is used` }
    : { load: true, reason: "bundled" };
}

type Factory = (pi: ExtensionAPI) => unknown;
/** The upstream entries' default exports (resolved from this package's or the umbrella's node_modules). */
export async function loadUpstream(): Promise<Factory[]> {
  const modules = await Promise.all(UPSTREAM_ENTRIES.map(entry => import(`${PACKAGE_NAME}/${entry}`) as Promise<{ default: Factory }>));
  return modules.map(module => module.default);
}

export function createCliproxyapiBundle(options: { env?: NodeJS.ProcessEnv; agentDir?: string; cwd?: string; projectTrusted?: boolean; load?: () => Promise<Factory[]> } = {}) {
  return async function cliproxyapiBundle(pi: ExtensionAPI): Promise<void> {
    if (!decideBundle(options).load) return;
    for (const factory of await (options.load ?? loadUpstream)()) await factory(pi);
  };
}

export default createCliproxyapiBundle();
