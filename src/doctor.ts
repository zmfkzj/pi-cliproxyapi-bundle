// `/cliproxyapi doctor|install-deps` and the umbrella's dependency provider (see dependencies.ts for the contract).
// Registered before the bundle decides whether to load the upstream provider, so it exists in every mode (bundled,
// separate install, PI_CLIPROXYAPI_BUNDLED=off) without loading the provider twice.
//
// check() is read-only. It resolves the CLIProxyAPI connection the way the upstream provider does
// (extensions/lib.ts resolveConnection/resolveEndpoints in @router-for-me/pi-cliproxyapi-provider: env >
// cliproxyapi.json > auth.json login > http://127.0.0.1:8317, models at {root}/v1/models?client_version=pi) without
// importing it (the bundled copy may be missing), and sends at most one short GET to that models endpoint.
// Keys are reported as set / not set and never printed.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatDependencyReport, insideNodeModules, installNpmDependencies, registerDependencyProvider, runProcess,
  type DependencyItem, type DependencyMode, type DependencyProvider, type DependencyReport,
} from "./dependencies.ts";

export const CLIPROXYAPI_DEPENDENCY_ID = "cliproxyapi";
export const CLIPROXYAPI_LABEL = "pi-cliproxyapi-bundle";
export const CLIPROXYAPI_COMMAND = "cliproxyapi";
export const UPSTREAM_PACKAGE = "@router-for-me/pi-cliproxyapi-provider";
export const DEFAULT_BASE_URL = "http://127.0.0.1:8317";
export const PROBE_TIMEOUT_MS = 3_000;
export const CLIPROXYAPI_USAGE = "Usage: /cliproxyapi doctor (check the provider, CLIProxyAPI server and API key) | /cliproxyapi install-deps";
/** This package's directory (src/..). */
export const PACKAGE_DIR = fileURLToPath(new URL("..", import.meta.url));
const SUBCOMMANDS = [
  { value: "doctor", label: "doctor", description: "Check the bundled provider, the CLIProxyAPI server and the API key" },
  { value: "install-deps", label: "install-deps", description: `Install the bundled ${UPSTREAM_PACKAGE} npm dependency` },
];

/** What the bundle decided and did when it loaded (filled in by the extension factory). */
export interface BundleState {
  decision?: { load: boolean; reason: string };
  /** Whether the bundled upstream entries finished loading. */
  loaded?: boolean;
  loadError?: string;
  /** The settings files that install the upstream package on its own (computed on demand). */
  separateInstalls?: () => string[];
}

export interface CliproxyapiDoctorOptions {
  packageDir?: string;
  /** Pi agent directory. Default: getAgentDir() at check time. */
  agentDir?: string;
  env?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  /** Probe timeout. Default: PROBE_TIMEOUT_MS. */
  timeoutMs?: number;
  /** npm runner for install-deps (tests). */
  run?: typeof runProcess;
  state?: BundleState;
}

type ProbeResult =
  | { kind: "ok"; status: number }
  | { kind: "auth"; status: number }
  | { kind: "http"; status: number }
  | { kind: "unreachable"; reason: string }
  | { kind: "unverified"; reason: string };

const UNREACHABLE = new Set(["ECONNREFUSED", "ENOTFOUND", "ECONNRESET", "EHOSTDOWN"]);

/** One GET with a short timeout. Never throws; the response body is discarded (never shown). */
export async function probeEndpoint(url: string, apiKey: string | undefined,
  options: { fetch?: typeof globalThis.fetch; timeoutMs?: number } = {}): Promise<ProbeResult> {
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;
  try {
    const headers: Record<string, string> = { Accept: "application/json" };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const response = await (options.fetch ?? globalThis.fetch)(url, { headers, signal: AbortSignal.timeout(timeoutMs) });
    await response.body?.cancel().catch(() => {});
    if (response.ok) return { kind: "ok", status: response.status };
    if (response.status === 401 || response.status === 403) return { kind: "auth", status: response.status };
    return { kind: "http", status: response.status };
  } catch (error) {
    const err = error as { name?: string; code?: string; cause?: { code?: string } };
    if (err?.name === "TimeoutError" || err?.name === "AbortError") return { kind: "unverified", reason: `no answer within ${timeoutMs} ms` };
    const code = err?.cause?.code ?? err?.code;
    if (code && UNREACHABLE.has(code)) return { kind: "unreachable", reason: code };
    return { kind: "unverified", reason: code ?? "network error" };
  }
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string" && value.trim()) return value.trim();
  return undefined;
}

function readJsonObject(path: string): { value: Record<string, unknown>; invalid: boolean } {
  if (!existsSync(path)) return { value: {}, invalid: false };
  try {
    const value: unknown = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? { value: value as Record<string, unknown>, invalid: false } : { value: {}, invalid: true };
  } catch { return { value: {}, invalid: true }; } // Never show the parser message: it can quote credentials.
}

export interface ConnectionSettings {
  providerId: string;
  providerName: string;
  configPath: string;
  configInvalid: boolean;
  baseUrlSource: string;
  /** Origin and models URL; undefined when the base URL is not a valid URL. */
  origin?: string;
  modelsUrl?: string;
  apiKey?: string;
  apiKeySource?: string;
}

/** The upstream provider's connection resolution (read-only). */
export function resolveConnectionSettings(agentDir: string, env: NodeJS.ProcessEnv): ConnectionSettings {
  const configPath = join(agentDir, "cliproxyapi.json");
  const config = readJsonObject(configPath);
  const file = config.value;
  const providerId = firstNonEmpty(env.CLIPROXYAPI_PROVIDER_ID, file.providerId) ?? "cliproxyapi";
  const providerName = firstNonEmpty(env.CLIPROXYAPI_PROVIDER_NAME, file.providerName) ?? "CLIProxyAPI";
  const entry = readJsonObject(join(agentDir, "auth.json")).value[providerId] as Record<string, unknown> | undefined;
  let authKey: string | undefined;
  let authBaseUrl: string | undefined;
  if (entry?.type === "oauth" && firstNonEmpty(entry.access)) {
    authKey = firstNonEmpty(entry.access);
    try {
      const meta = typeof entry.refresh === "string" && entry.refresh.trim() ? JSON.parse(entry.refresh) as { baseUrl?: unknown } : undefined;
      authBaseUrl = firstNonEmpty(meta?.baseUrl);
    } catch { /* Older / non-JSON refresh tokens carry no URL. */ }
  } else if (entry?.type === "api_key" && firstNonEmpty(entry.key)) {
    authKey = firstNonEmpty(entry.key);
  }
  const pick = (candidates: [unknown, string][]): [string, string] | undefined => {
    for (const [value, source] of candidates) { const text = firstNonEmpty(value); if (text) return [text, source]; }
    return undefined;
  };
  const [baseUrl, baseUrlSource] = pick([[env.CLIPROXYAPI_BASE_URL, "CLIPROXYAPI_BASE_URL"], [file.baseUrl, "cliproxyapi.json baseUrl"],
    [authBaseUrl, `auth.json ${providerId} login`], [DEFAULT_BASE_URL, "default"]])!;
  const key = pick([[env.CLIPROXYAPI_API_KEY, "CLIPROXYAPI_API_KEY"], [file.apiKey, "cliproxyapi.json apiKey"],
    [authKey, entry?.type === "oauth" ? `auth.json ${providerId} login` : `auth.json ${providerId} API key`]]);
  const settings: ConnectionSettings = { providerId, providerName, configPath, configInvalid: config.invalid, baseUrlSource,
    apiKey: key?.[0], apiKeySource: key?.[1] };
  try {
    const url = new URL(/^https?:\/\//i.test(baseUrl) ? baseUrl : `http://${baseUrl}`);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported scheme");
    let path = url.pathname.replace(/\/+$/, "");
    if (path === "/v1") path = "/backend-api";
    else if (path.endsWith("/v1")) path = `${path.slice(0, -"/v1".length)}/backend-api`;
    else if (path === "" || path === "/") path = "/backend-api";
    else if (!path.endsWith("/backend-api")) path = `${path}/backend-api`;
    const rootPath = path.replace(/\/backend-api$/, "");
    settings.origin = url.origin;
    settings.modelsUrl = `${url.origin}${`${rootPath}/v1/models`.replace(/\/{2,}/g, "/")}?client_version=pi`;
  } catch { /* reported as an invalid base URL */ }
  return settings;
}

/** Directory of `name` as Node resolves it from `packageDir` (its node_modules or a parent's). */
function installedPackageDir(packageDir: string, name: string): string | undefined {
  for (let dir = resolve(packageDir); ; dir = dirname(dir)) {
    if (existsSync(join(dir, "node_modules", name, "package.json"))) return join(dir, "node_modules", name);
    if (dirname(dir) === dir) return undefined;
  }
}

function lockedVersion(packageDir: string, name: string): string | undefined {
  const lock = readJsonObject(join(packageDir, "package-lock.json")).value;
  const entry = (lock.packages as Record<string, { version?: unknown }> | undefined)?.[`node_modules/${name}`];
  return typeof entry?.version === "string" ? entry.version : undefined;
}

function providerItem(state: BundleState | undefined, env: NodeJS.ProcessEnv): DependencyItem | undefined {
  const decision = state?.decision;
  if (!decision) return undefined;
  const name = "CLIProxyAPI provider";
  const separate = () => { try { return state?.separateInstalls?.() ?? []; } catch { return []; } };
  const removeSeparate = `pi remove npm:${UPSTREAM_PACKAGE}`;
  if (decision.load) {
    const files = /^on$/i.test(env.PI_CLIPROXYAPI_BUNDLED?.trim() ?? "") ? separate() : [];
    if (files.length) {
      return { name, status: "error", detail: `PI_CLIPROXYAPI_BUNDLED=on while ${UPSTREAM_PACKAGE} is also installed on its own (${files.join(", ")}): the provider loads twice`,
        action: `Unset PI_CLIPROXYAPI_BUNDLED (auto) and restart Pi, or remove the separate install: ${removeSeparate}` };
    }
    if (state?.loadError) {
      return { name, status: "error", detail: `the bundled copy failed to load: ${state.loadError}`,
        action: "Run /cliproxyapi install-deps, then /reload" };
    }
    return { name, status: "ok", detail: `bundled copy ${state?.loaded ? "loaded" : "selected"} (${decision.reason})` };
  }
  const files = separate();
  if (files.length) {
    return { name, status: "ok", detail: `the separate install is active (${files.join(", ")}); the bundled copy is not loaded`
      + (/^off$/i.test(env.PI_CLIPROXYAPI_BUNDLED?.trim() ?? "") ? " (PI_CLIPROXYAPI_BUNDLED=off)" : "") };
  }
  return { name, status: "manual", detail: `not loaded: ${decision.reason}, and no separate install`,
    action: `Unset PI_CLIPROXYAPI_BUNDLED (or set it to auto) and restart Pi, or install it on its own: pi install npm:${UPSTREAM_PACKAGE}` };
}

function npmItem(packageDir: string, bundleActive: boolean): DependencyItem {
  const name = `npm ${UPSTREAM_PACKAGE}`;
  const dir = installedPackageDir(packageDir, UPSTREAM_PACKAGE);
  const locked = lockedVersion(packageDir, UPSTREAM_PACKAGE);
  const reinstall = insideNodeModules(packageDir)
    ? "Reinstall the package with pi update --extensions (or pi install), then /reload"
    : `Run: cd ${packageDir} && npm ci --legacy-peer-deps (installs the locked version), then /reload`;
  if (!dir) {
    const action = "Run /cliproxyapi install-deps, then /reload";
    return bundleActive
      ? { name, status: "error", detail: "the bundled copy is not installed", action }
      : { name, status: "warn", optional: true, detail: "the bundled copy is not installed (not used while it is not loaded)", action };
  }
  const version = readJsonObject(join(dir, "package.json")).value.version;
  const installed = typeof version === "string" ? version : "unknown version";
  const where = bundleActive ? "" : " (not loaded)";
  if (locked && installed !== locked) {
    return { name, status: "warn", optional: !bundleActive, detail: `installed ${installed}, package-lock.json pins ${locked}${where}`, action: reinstall };
  }
  return { name, status: "ok", detail: `${installed}${locked ? " (matches package-lock.json)" : ""}${where}` };
}

export async function checkCliproxyapi(options: CliproxyapiDoctorOptions = {}): Promise<DependencyReport> {
  const packageDir = options.packageDir ?? PACKAGE_DIR;
  const agentDir = options.agentDir ?? getAgentDir();
  const env = options.env ?? process.env;
  const items: DependencyItem[] = [];
  const provider = providerItem(options.state, env);
  if (provider) items.push(provider);
  items.push(npmItem(packageDir, options.state?.decision?.load ?? true));

  const settings = resolveConnectionSettings(agentDir, env);
  const keyAction = `Run /login ${settings.providerName}, or set CLIPROXYAPI_API_KEY, or apiKey in ${settings.configPath}`;
  const urlAction = `Set CLIPROXYAPI_BASE_URL or baseUrl in ${settings.configPath} to the CLIProxyAPI address (e.g. ${DEFAULT_BASE_URL}), or run /login ${settings.providerName}`;
  if (settings.configInvalid) {
    items.push({ name: "cliproxyapi.json", status: "error", detail: `${settings.configPath} is not a valid JSON object; the provider ignores it`,
      action: `Fix the JSON in ${settings.configPath} (or remove the file)` });
  }
  if (settings.origin) items.push({ name: "CLIProxyAPI base URL", status: "ok", detail: `${settings.origin} (from ${settings.baseUrlSource})` });
  // The raw value is not shown: a malformed URL can carry credentials.
  else items.push({ name: "CLIProxyAPI base URL", status: "error", detail: `invalid http(s) URL (from ${settings.baseUrlSource})`, action: urlAction });
  items.push(settings.apiKey
    ? { name: "CLIProxyAPI API key", status: "ok", detail: `set (from ${settings.apiKeySource})` }
    : { name: "CLIProxyAPI API key", status: "manual", detail: "not set: the provider lists no models", action: keyAction });
  if (!settings.origin || !settings.modelsUrl) return { items };

  const result = await probeEndpoint(settings.modelsUrl, settings.apiKey, options);
  const server = "CLIProxyAPI server";
  const origin = settings.origin;
  switch (result.kind) {
    case "ok":
      items.push({ name: server, status: "ok", detail: `models endpoint reachable at ${origin}${settings.apiKey ? ", API key accepted" : ""}` });
      break;
    case "auth":
      items.push(settings.apiKey
        ? { name: server, status: "manual", detail: `reachable at ${origin}, but it rejected the API key (HTTP ${result.status})`, action: keyAction }
        : { name: server, status: "ok", detail: `reachable at ${origin}; requests need the API key (HTTP ${result.status} without it)` });
      break;
    case "http":
      items.push({ name: server, status: "error", detail: `HTTP ${result.status} from the models endpoint at ${origin}`,
        action: `Check that CLIProxyAPI is healthy and that the base URL points to it. ${urlAction}` });
      break;
    case "unreachable":
      items.push({ name: server, status: "error", detail: `not reachable at ${origin} (${result.reason})`,
        action: `Start the CLIProxyAPI server, or fix the base URL: ${urlAction}` });
      break;
    case "unverified":
      items.push({ name: server, status: "unverified", detail: `could not check ${origin} (${result.reason})`,
        action: `Check by hand: curl -sS -o /dev/null -w '%{http_code}\\n' -H "Authorization: Bearer $CLIPROXYAPI_API_KEY" '${settings.modelsUrl}' (200 = OK, 401 = bad key)` });
      break;
  }
  return { items };
}

export const CLIPROXYAPI_INSTALL_NOTE = `Installs only the bundled npm dependency ${UPSTREAM_PACKAGE}; `
  + "the CLIProxyAPI server, its API key and /login are manual.";

/** npm install of the bundled provider (when missing), then a re-check whose remaining problems are manual. */
export async function installCliproxyapi(options: CliproxyapiDoctorOptions = {}): Promise<DependencyReport> {
  const packageDir = options.packageDir ?? PACKAGE_DIR;
  const npm = await installNpmDependencies(packageDir, { env: options.env, run: options.run,
    reinstallHint: "Reinstall the package with pi update --extensions (or pi install), then /reload" });
  const after = await checkCliproxyapi(options);
  const rest = after.items.filter((item) => !item.name.startsWith("npm "))
    .map((item) => item.status === "error" ? { ...item, status: "manual" as const } : item);
  return { note: CLIPROXYAPI_INSTALL_NOTE, items: [...npm, ...rest] };
}

export function createCliproxyapiDependencyProvider(options: CliproxyapiDoctorOptions = {}): DependencyProvider {
  let installing: Promise<DependencyReport> | undefined;
  return {
    id: CLIPROXYAPI_DEPENDENCY_ID,
    label: CLIPROXYAPI_LABEL,
    command: `/${CLIPROXYAPI_COMMAND}`,
    check: () => checkCliproxyapi(options),
    install: () => installing ??= installCliproxyapi(options).finally(() => { installing = undefined; }),
  };
}

interface CommandUi {
  notify(message: string, level?: "info" | "warning" | "error"): void;
  setStatus?(key: string, text: string | undefined): void;
}

async function runMode(provider: DependencyProvider, mode: DependencyMode, ctx: { ui: CommandUi }): Promise<void> {
  if (mode === "install") ctx.ui.setStatus?.(CLIPROXYAPI_DEPENDENCY_ID, `${CLIPROXYAPI_LABEL}: installing dependencies…`);
  try {
    const report = await (mode === "check" ? provider.check(ctx) : provider.install(ctx));
    const { text, level } = formatDependencyReport(CLIPROXYAPI_LABEL, report, mode);
    ctx.ui.notify(text, level);
  } catch (error) {
    ctx.ui.notify(`${CLIPROXYAPI_LABEL} ${mode === "check" ? "doctor" : "install-deps"} failed: ${error instanceof Error ? error.message : String(error)}`, "error");
  } finally {
    if (mode === "install") ctx.ui.setStatus?.(CLIPROXYAPI_DEPENDENCY_ID, undefined);
  }
}

/** Register `/cliproxyapi doctor|install-deps` and answer the umbrella's dependency requests. */
export function registerCliproxyapiCommand(pi: Pick<ExtensionAPI, "registerCommand" | "events">,
  options: CliproxyapiDoctorOptions = {}): DependencyProvider {
  const provider = createCliproxyapiDependencyProvider(options);
  registerDependencyProvider(pi.events, provider);
  pi.registerCommand(CLIPROXYAPI_COMMAND, {
    description: "pi-cliproxyapi-bundle maintenance: doctor | install-deps",
    getArgumentCompletions: (prefix) => {
      const word = prefix.trimStart().toLowerCase();
      if (/\s/.test(word)) return null;
      const items = SUBCOMMANDS.filter((item) => item.value.startsWith(word));
      return items.length ? items : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "doctor") return runMode(provider, "check", ctx);
      if (sub === "install-deps") return runMode(provider, "install", ctx);
      ctx.ui.notify(CLIPROXYAPI_USAGE, sub === "" || sub === "help" ? "info" : "warning");
    },
  });
  return provider;
}
