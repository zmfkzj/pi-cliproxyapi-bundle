// `/cliproxyapi-bundle doctor|install-deps` and the umbrella's dependency provider (see dependencies.ts for the contract).
// Registered before the bundle decides whether to load the upstream provider, so it exists in every mode (bundled,
// separate install, PI_CLIPROXYAPI_BUNDLED=off) without loading the provider twice. Not `/cliproxyapi`: the upstream
// provider registers that name itself, and Pi would rename both to `/cliproxyapi:1` and `/cliproxyapi:2`.
//
// check() is read-only. It resolves the CLIProxyAPI connection the way the upstream provider does
// (src/config.ts loadConfig and src/registration.ts in pi-cliproxyapi-provider: env > ~/.pi/agent/pi-cliproxyapi-provider/
// config.json (under the home directory, not PI_CODING_AGENT_DIR) > defaults; models at `<baseUrl>/models`; key from a
// stored `/login <provider>` API key, then config `apiKey`, then CLIPROXYAPI_API_KEY) without importing it (the bundled
// copy may be missing), and sends at most one short GET to that models endpoint. Keys are reported as set / not set and
// never printed; `!command` keys are never run.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  formatDependencyReport, insideNodeModules, installNpmDependencies, registerDependencyProvider, runProcess,
  type DependencyItem, type DependencyMode, type DependencyProvider, type DependencyReport,
} from "./dependencies.ts";

export const CLIPROXYAPI_DEPENDENCY_ID = "cliproxyapi";
export const CLIPROXYAPI_LABEL = "pi-cliproxyapi-bundle";
export const CLIPROXYAPI_COMMAND = "cliproxyapi-bundle";
export const UPSTREAM_PACKAGE = "pi-cliproxyapi-provider";
export const DEFAULT_PROVIDER_NAME = "cpa";
export const DEFAULT_BASE_URL = "http://localhost:8317/v1";
export const PROBE_TIMEOUT_MS = 3_000;
export const CLIPROXYAPI_USAGE = "Usage: /cliproxyapi-bundle doctor (check the provider, CLIProxyAPI server and API key) | /cliproxyapi-bundle install-deps";
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
  /** Pi agent directory (auth.json). Default: getAgentDir() at check time. */
  agentDir?: string;
  /** Home directory of the provider's global config (`<home>/.pi/agent/pi-cliproxyapi-provider/config.json`). Default: os.homedir(). */
  homeDir?: string;
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
  providerName: string;
  providerNameSource: string;
  configPath: string;
  configInvalid: boolean;
  baseUrlSource: string;
  /** Origin and models URL; undefined when the base URL is not a valid URL. */
  origin?: string;
  modelsUrl?: string;
  authRequired: boolean;
  /** A literal key that the probe may send (never a `!command`). */
  apiKey?: string;
  apiKeySource?: string;
  /** auth.json holds an OAuth-type entry for the provider name (the former provider's `/login`), which this provider cannot use. */
  oauthEntry?: boolean;
  /** The former provider's `<agentDir>/cliproxyapi.json`, when it exists and the new config does not. */
  legacyConfig?: { path: string; providerId: string; baseUrl: string };
}

function parseBoolean(value: string | undefined): boolean | undefined {
  const text = value?.trim().toLowerCase();
  if (text === undefined) return undefined;
  if (["1", "true", "yes", "on"].includes(text)) return true;
  if (["0", "false", "no", "off"].includes(text)) return false;
  return undefined;
}

/** The upstream provider's connection resolution (read-only). */
export function resolveConnectionSettings(agentDir: string, env: NodeJS.ProcessEnv, homeDir: string = homedir()): ConnectionSettings {
  const configPath = join(homeDir, ".pi", "agent", "pi-cliproxyapi-provider", "config.json");
  const config = readJsonObject(configPath);
  const file = config.value;
  const pick = (candidates: [unknown, string][]): [string, string] | undefined => {
    for (const [value, source] of candidates) { const text = firstNonEmpty(value); if (text) return [text, source]; }
    return undefined;
  };
  const [providerName, providerNameSource] = pick([[env.CLIPROXYAPI_PROVIDER_NAME, "CLIPROXYAPI_PROVIDER_NAME"],
    [file.providerName, "config.json providerName"], [DEFAULT_PROVIDER_NAME, "default"]])!;
  const [baseUrl, baseUrlSource] = pick([[env.CLIPROXYAPI_BASE_URL, "CLIPROXYAPI_BASE_URL"], [file.baseUrl, "config.json baseUrl"],
    [DEFAULT_BASE_URL, "default"]])!;
  const authRequired = parseBoolean(env.CLIPROXYAPI_AUTH_REQUIRED) ?? (typeof file.authRequired === "boolean" ? file.authRequired : true);
  const entry = readJsonObject(join(agentDir, "auth.json")).value[providerName] as Record<string, unknown> | undefined;
  // Pi's order: a stored `/login` API key, then the provider's `apiKey` (config `apiKey`, else `$CLIPROXYAPI_API_KEY`).
  const stored = entry?.type === "api_key" ? firstNonEmpty(entry.key) : undefined;
  const configKey = firstNonEmpty(file.apiKey);
  const key = stored ? [stored, `auth.json ${providerName} login`]
    : configKey ? [configKey, configKey.startsWith("!") ? "config.json apiKey command, not run here" : "config.json apiKey"]
    : pick([[env.CLIPROXYAPI_API_KEY, "CLIPROXYAPI_API_KEY"]]);
  const settings: ConnectionSettings = { providerName, providerNameSource, configPath, configInvalid: config.invalid, baseUrlSource, authRequired,
    apiKey: key && !key[0].startsWith("!") ? key[0] : undefined, apiKeySource: key?.[1], oauthEntry: entry?.type === "oauth" };
  const legacyPath = join(agentDir, "cliproxyapi.json");
  if (!existsSync(configPath) && existsSync(legacyPath)) {
    const legacy = readJsonObject(legacyPath).value;
    settings.legacyConfig = { path: legacyPath, providerId: firstNonEmpty(legacy.providerId) ?? "cliproxyapi",
      baseUrl: firstNonEmpty(legacy.baseUrl) ?? "http://127.0.0.1:8317" };
  }
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported scheme");
    settings.origin = url.origin;
    settings.modelsUrl = `${baseUrl.replace(/\/+$/, "")}/models`;
  } catch { /* reported as an invalid base URL */ }
  return settings;
}

/** The former provider's base URL (an origin, `/v1` optional) as the `/v1` base URL this provider expects. */
function legacyBaseUrl(value: string): string {
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `http://${value}`);
    const path = url.pathname.replace(/\/+$/, "").replace(/\/backend-api$/, "").replace(/\/v1$/, "");
    return `${url.origin}${path}/v1`;
  } catch { return DEFAULT_BASE_URL; }
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
        action: "Run /cliproxyapi-bundle install-deps, then /reload" };
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
    const action = "Run /cliproxyapi-bundle install-deps, then /reload";
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

  const settings = resolveConnectionSettings(agentDir, env, options.homeDir);
  const name = settings.providerName;
  const keyAction = `Run /login ${name} (API key), or set apiKey in ${settings.configPath}, or CLIPROXYAPI_API_KEY`;
  const urlAction = `Set CLIPROXYAPI_BASE_URL or baseUrl in ${settings.configPath} (or run /cliproxyapi config connection) to the CLIProxyAPI /v1 address (e.g. ${DEFAULT_BASE_URL})`;
  if (settings.configInvalid) {
    items.push({ name: "CLIProxyAPI config", status: "error", detail: `${settings.configPath} is not a valid JSON object; the provider does not load its settings`,
      action: `Fix the JSON in ${settings.configPath} (or remove the file and run /cliproxyapi config)` });
  }
  if (settings.legacyConfig) {
    const legacy = settings.legacyConfig;
    items.push({ name: "former provider config", status: "warn", optional: true,
      detail: `${legacy.path} (the former @router-for-me provider's) is not read by ${UPSTREAM_PACKAGE}; models are registered as ${name}/<model>`,
      action: `To keep "${legacy.providerId}/<model>" selections: create ${settings.configPath} with {"providerName": "${legacy.providerId}", "baseUrl": "${legacyBaseUrl(legacy.baseUrl)}"} (or run /cliproxyapi config), then /login ${legacy.providerId} with the API key and /reload` });
  }
  items.push({ name: "CLIProxyAPI provider name", status: "ok", detail: `${name} (from ${settings.providerNameSource}); models are ${name}/<model>` });
  if (settings.origin) items.push({ name: "CLIProxyAPI base URL", status: "ok", detail: `${settings.origin} (from ${settings.baseUrlSource})` });
  // The raw value is not shown: a malformed URL can carry credentials.
  else items.push({ name: "CLIProxyAPI base URL", status: "error", detail: `invalid http(s) URL (from ${settings.baseUrlSource})`, action: urlAction });
  if (settings.oauthEntry) {
    items.push({ name: "CLIProxyAPI login", status: "manual",
      detail: `auth.json has an OAuth-type ${name} entry (the former provider's /login); ${UPSTREAM_PACKAGE} discovers no models with it`,
      action: `Run /login ${name} and enter the CLIProxyAPI API key (replaces that entry), then /reload` });
  }
  if (!settings.authRequired) items.push({ name: "CLIProxyAPI API key", status: "ok", detail: "not required (authRequired false)" });
  else items.push(settings.apiKeySource
    ? { name: "CLIProxyAPI API key", status: "ok", detail: `set (from ${settings.apiKeySource})` }
    : { name: "CLIProxyAPI API key", status: "manual", detail: "not set: the provider lists no models", action: keyAction });
  if (!settings.origin || !settings.modelsUrl) return { items };

  const sentKey = settings.authRequired ? settings.apiKey : undefined;

  const result = await probeEndpoint(settings.modelsUrl, sentKey, options);
  const server = "CLIProxyAPI server";
  const origin = settings.origin;
  switch (result.kind) {
    case "ok":
      items.push({ name: server, status: "ok", detail: `models endpoint reachable at ${origin}${sentKey ? ", API key accepted" : ""}` });
      break;
    case "auth":
      items.push(sentKey
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

/** Register `/cliproxyapi-bundle doctor|install-deps` and answer the umbrella's dependency requests. */
export function registerCliproxyapiCommand(pi: Pick<ExtensionAPI, "registerCommand" | "events">,
  options: CliproxyapiDoctorOptions = {}): DependencyProvider {
  const provider = createCliproxyapiDependencyProvider(options);
  registerDependencyProvider(pi.events, provider);
  pi.registerCommand(CLIPROXYAPI_COMMAND, {
    description: "pi-cliproxyapi-bundle maintenance: doctor | install-deps (the provider's own command is /cliproxyapi)",
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
