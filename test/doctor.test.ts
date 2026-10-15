// `/cliproxyapi doctor|install-deps` and the umbrella dependency provider: a temporary package directory, a temporary
// agent directory, a local stand-in for CLIProxyAPI and a recorded fake npm (nothing is installed or downloaded).
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { DEPENDENCY_CHANNEL, type DependencyProvider, type DependencyReport, type RunResult } from "../src/dependencies.ts";
import { checkCliproxyapi, createCliproxyapiDependencyProvider, installCliproxyapi, registerCliproxyapiCommand,
  UPSTREAM_PACKAGE, type BundleState, type CliproxyapiDoctorOptions } from "../src/doctor.ts";

const KEY = "sk-cliproxyapi-doctor-test-0123456789";
const BUNDLED: BundleState = { decision: { load: true, reason: "bundled" }, loaded: true, separateInstalls: () => [] };

function setup(t: TestContext, options: { installed?: string | false; locked?: string; packageDir?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi cliproxyapi doctor "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const agentDir = join(root, "agent");
  const packageDir = join(root, options.packageDir ?? "bundle");
  const bin = join(root, "bin");
  for (const dir of [agentDir, packageDir, bin]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(packageDir, "package.json"), JSON.stringify({ name: "pi-cliproxyapi-bundle", dependencies: { [UPSTREAM_PACKAGE]: "^1.4.22" } }));
  writeFileSync(join(packageDir, "package-lock.json"), JSON.stringify({ packages: { "": {}, [`node_modules/${UPSTREAM_PACKAGE}`]: { version: options.locked ?? "1.4.22" } } }));
  const install = (version: string) => {
    mkdirSync(join(packageDir, "node_modules", UPSTREAM_PACKAGE), { recursive: true });
    writeFileSync(join(packageDir, "node_modules", UPSTREAM_PACKAGE, "package.json"), JSON.stringify({ name: UPSTREAM_PACKAGE, version }));
  };
  if (options.installed !== false) install(options.installed ?? "1.4.22");
  writeFileSync(join(bin, "npm"), "#!/bin/sh\nexit 0\n");
  chmodSync(join(bin, "npm"), 0o755);
  return { root, agentDir, packageDir, bin, install };
}

const requests: { url?: string; auth?: string; method?: string }[] = [];
async function serve(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void): Promise<{ url: string; close: () => Promise<void> }> {
  const server: Server = createServer((request, response) => {
    requests.push({ method: request.method, url: request.url, auth: request.headers.authorization });
    handler(request, response);
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  let closed = false;
  const close = async () => { if (!closed) { closed = true; server.closeAllConnections(); await new Promise((done) => server.close(done)); } };
  t.after(close);
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, close };
}

/** A stand-in for CLIProxyAPI: 200 on the models endpoint with the right key, 401 otherwise. */
const gateway = (request: IncomingMessage, response: ServerResponse) => {
  if (request.url?.endsWith("/v1/models?client_version=pi") && request.headers.authorization === `Bearer ${KEY}`) {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ models: [{ slug: "fake" }] }));
    return;
  }
  response.writeHead(401);
  response.end(`unauthorized ${request.headers.authorization ?? ""}`);
};

function item(report: DependencyReport, name: string) {
  return report.items.find((entry) => entry.name === name || entry.name.startsWith(`${name} `));
}

function options(s: ReturnType<typeof setup>, env: NodeJS.ProcessEnv, extra: CliproxyapiDoctorOptions = {}): CliproxyapiDoctorOptions {
  return { packageDir: s.packageDir, agentDir: s.agentDir, env: { PATH: s.bin, ...env }, timeoutMs: 2_000, state: BUNDLED, ...extra };
}

test("healthy: bundled provider loaded, locked version installed, server reachable with an accepted key", async (t) => {
  const s = setup(t);
  const server = await serve(t, gateway);
  requests.length = 0;
  const report = await checkCliproxyapi(options(s, { CLIPROXYAPI_BASE_URL: `${server.url}/v1`, CLIPROXYAPI_API_KEY: KEY }));
  assert.deepEqual(report.items.map((entry) => [entry.name, entry.status]), [
    ["CLIProxyAPI provider", "ok"], [`npm ${UPSTREAM_PACKAGE}`, "ok"], ["CLIProxyAPI base URL", "ok"], ["CLIProxyAPI API key", "ok"], ["CLIProxyAPI server", "ok"]]);
  assert.equal(item(report, "npm")?.detail, "1.4.22 (matches package-lock.json)");
  assert.equal(item(report, "CLIProxyAPI base URL")?.detail, `${server.url} (from CLIPROXYAPI_BASE_URL)`);
  assert.equal(item(report, "CLIProxyAPI API key")?.detail, "set (from CLIPROXYAPI_API_KEY)");
  assert.ok(!JSON.stringify(report).includes(KEY));
  assert.deepEqual(requests, [{ method: "GET", url: "/v1/models?client_version=pi", auth: `Bearer ${KEY}` }]);
});

test("resolves like the upstream provider: providerId/providerName, auth.json login, base URL path normalization", async (t) => {
  const s = setup(t);
  const server = await serve(t, gateway);
  writeFileSync(join(s.agentDir, "cliproxyapi.json"), JSON.stringify({ providerId: "myproxy", providerName: "MyProxy" }));
  writeFileSync(join(s.agentDir, "auth.json"), JSON.stringify({ myproxy: { type: "oauth", access: KEY, refresh: JSON.stringify({ baseUrl: `${server.url}/prefix/backend-api` }) } }));
  requests.length = 0;
  const report = await checkCliproxyapi(options(s, {}));
  assert.equal(item(report, "CLIProxyAPI base URL")?.detail, `${server.url} (from auth.json myproxy login)`);
  assert.equal(item(report, "CLIProxyAPI API key")?.detail, "set (from auth.json myproxy login)");
  assert.equal(item(report, "CLIProxyAPI server")?.status, "ok");
  assert.equal(requests[0]?.url, "/prefix/v1/models?client_version=pi");
  writeFileSync(join(s.agentDir, "auth.json"), "{}");
  const missing = await checkCliproxyapi(options(s, { CLIPROXYAPI_BASE_URL: server.url }));
  assert.match(item(missing, "CLIProxyAPI API key")?.action ?? "", /^Run \/login MyProxy, or set CLIPROXYAPI_API_KEY/);
});

test("missing or rejected API key: manual with the login action; the key is never shown", async (t) => {
  const s = setup(t);
  const server = await serve(t, gateway);
  const missing = await checkCliproxyapi(options(s, { CLIPROXYAPI_BASE_URL: server.url }));
  assert.equal(item(missing, "CLIProxyAPI API key")?.status, "manual");
  assert.match(item(missing, "CLIProxyAPI API key")?.action ?? "", /\/login CLIProxyAPI/);
  assert.equal(item(missing, "CLIProxyAPI server")?.status, "ok", "reachable, needs the key");
  const rejected = await checkCliproxyapi(options(s, { CLIPROXYAPI_BASE_URL: server.url, CLIPROXYAPI_API_KEY: "sk-wrong-0123456789" }));
  assert.equal(item(rejected, "CLIProxyAPI server")?.status, "manual");
  assert.match(item(rejected, "CLIProxyAPI server")?.detail ?? "", /rejected the API key \(HTTP 401\)/);
  assert.match(item(rejected, "CLIProxyAPI server")?.action ?? "", /\/login CLIProxyAPI/);
  assert.ok(!JSON.stringify(rejected).includes("sk-wrong"));
});

test("server down: error with the start/fix action; no answer in time: unverified with a manual check", async (t) => {
  const s = setup(t);
  const down = await serve(t, gateway);
  await down.close();
  const report = await checkCliproxyapi(options(s, { CLIPROXYAPI_BASE_URL: down.url, CLIPROXYAPI_API_KEY: KEY }));
  assert.equal(item(report, "CLIProxyAPI server")?.status, "error");
  assert.match(item(report, "CLIProxyAPI server")?.detail ?? "", /not reachable at .*ECONNREFUSED/);
  assert.match(item(report, "CLIProxyAPI server")?.action ?? "", /^Start the CLIProxyAPI server, or fix the base URL/);
  const silent = await serve(t, () => { /* never answers */ });
  const slow = await checkCliproxyapi(options(s, { CLIPROXYAPI_BASE_URL: silent.url, CLIPROXYAPI_API_KEY: KEY }, { timeoutMs: 200 }));
  assert.equal(item(slow, "CLIProxyAPI server")?.status, "unverified");
  assert.match(item(slow, "CLIProxyAPI server")?.action ?? "", /curl .*\/v1\/models\?client_version=pi/);
  assert.ok(!JSON.stringify(slow).includes(KEY));
});

test("invalid base URL and cliproxyapi.json: errors without their contents and without a probe", async (t) => {
  const s = setup(t);
  writeFileSync(join(s.agentDir, "cliproxyapi.json"), `{"apiKey": "${KEY}", broken`);
  const fetch = (async () => { throw new Error("must not probe"); }) as typeof globalThis.fetch;
  const report = await checkCliproxyapi(options(s, { CLIPROXYAPI_BASE_URL: "http://user:secret@[bad" }, { fetch }));
  assert.equal(item(report, "cliproxyapi.json")?.status, "error");
  assert.equal(item(report, "CLIProxyAPI base URL")?.status, "error");
  assert.equal(item(report, "CLIProxyAPI server"), undefined);
  assert.ok(!JSON.stringify(report).includes("secret") && !JSON.stringify(report).includes(KEY));
});

test("bundled npm dependency: missing (error, or optional warn when not loaded) and lock mismatch", async (t) => {
  const s = setup(t, { installed: false });
  const fetch = (async () => new Response("{}")) as typeof globalThis.fetch;
  const missing = await checkCliproxyapi(options(s, { CLIPROXYAPI_API_KEY: KEY }, { fetch }));
  assert.equal(item(missing, "npm")?.status, "error");
  assert.equal(item(missing, "npm")?.action, "Run /cliproxyapi install-deps, then /reload");
  const separate: BundleState = { decision: { load: false, reason: "installed on its own" }, separateInstalls: () => ["/x/settings.json"] };
  const unused = await checkCliproxyapi(options(s, { CLIPROXYAPI_API_KEY: KEY }, { fetch, state: separate }));
  assert.equal(item(unused, "npm")?.status, "warn");
  assert.equal(item(unused, "npm")?.optional, true);
  s.install("1.4.30");
  const mismatch = await checkCliproxyapi(options(s, { CLIPROXYAPI_API_KEY: KEY }, { fetch }));
  assert.equal(item(mismatch, "npm")?.status, "warn");
  assert.match(item(mismatch, "npm")?.detail ?? "", /installed 1\.4\.30, package-lock\.json pins 1\.4\.22/);
  assert.match(item(mismatch, "npm")?.action ?? "", /npm ci --legacy-peer-deps/);
});

test("which install is active: bundled, separate, off, forced on twice, failed load", async (t) => {
  const s = setup(t);
  const fetch = (async () => new Response("{}")) as typeof globalThis.fetch;
  const provider = async (state: BundleState, env: NodeJS.ProcessEnv = {}) =>
    item(await checkCliproxyapi(options(s, { CLIPROXYAPI_API_KEY: KEY, ...env }, { fetch, state })), "CLIProxyAPI provider")!;
  assert.deepEqual(await provider(BUNDLED), { name: "CLIProxyAPI provider", status: "ok", detail: "bundled copy loaded (bundled)" });
  const separate = await provider({ decision: { load: false, reason: "installed on its own" }, separateInstalls: () => ["/a/settings.json"] });
  assert.equal(separate.status, "ok");
  assert.match(separate.detail ?? "", /the separate install is active \(\/a\/settings\.json\)/);
  const off = await provider({ decision: { load: false, reason: "PI_CLIPROXYAPI_BUNDLED=off" }, separateInstalls: () => [] }, { PI_CLIPROXYAPI_BUNDLED: "off" });
  assert.equal(off.status, "manual");
  assert.match(off.action ?? "", /Unset PI_CLIPROXYAPI_BUNDLED/);
  const twice = await provider({ decision: { load: true, reason: "PI_CLIPROXYAPI_BUNDLED=on" }, loaded: true, separateInstalls: () => ["/a/settings.json"] }, { PI_CLIPROXYAPI_BUNDLED: "on" });
  assert.equal(twice.status, "error");
  assert.match(twice.action ?? "", /pi remove npm:@router-for-me\/pi-cliproxyapi-provider/);
  const failed = await provider({ decision: { load: true, reason: "bundled" }, loadError: "Cannot find package", separateInstalls: () => [] });
  assert.equal(failed.status, "error");
  assert.match(failed.action ?? "", /\/cliproxyapi install-deps/);
});

test("install-deps: npm install when missing, then ok when repeated; check never runs npm", async (t) => {
  const s = setup(t, { installed: false });
  const server = await serve(t, gateway);
  const calls: string[][] = [];
  const run = async (command: string, args: string[], opts: { cwd?: string } = {}): Promise<RunResult> => {
    calls.push([command, ...args, `cwd=${opts.cwd}`]);
    s.install("1.4.22");
    return { code: 0, stdout: "added 1 package", stderr: "" };
  };
  const opts = options(s, { CLIPROXYAPI_BASE_URL: server.url, CLIPROXYAPI_API_KEY: KEY }, { run });
  await checkCliproxyapi(opts);
  assert.deepEqual(calls, [], "check never installs");
  const first = await installCliproxyapi(opts);
  assert.match(first.note ?? "", /Installs only the bundled npm dependency/);
  assert.deepEqual(first.items[0], { name: "npm dependencies", status: "installed", detail: `installed ${UPSTREAM_PACKAGE}`, action: "Run /reload to load them" });
  assert.deepEqual(calls, [["npm", "install", "--legacy-peer-deps", "--no-audit", "--no-fund", `cwd=${s.packageDir}`]]);
  assert.ok(first.items.slice(1).every((entry) => entry.status === "ok"), JSON.stringify(first.items));
  const second = await installCliproxyapi(opts);
  assert.deepEqual(second.items[0], { name: "npm dependencies", status: "ok", detail: "already installed" });
  assert.equal(calls.length, 1, "nothing installed the second time");
});

test("install-deps: npm failure is reported with a manual command; server and key problems are manual", async (t) => {
  const s = setup(t, { installed: false });
  const down = await serve(t, gateway);
  await down.close();
  const run = async (): Promise<RunResult> => ({ code: 1, stdout: "", stderr: "npm error code E404" });
  const report = await installCliproxyapi(options(s, { CLIPROXYAPI_BASE_URL: down.url }, { run }));
  assert.equal(report.items[0]?.status, "failed");
  assert.match(report.items[0]?.detail ?? "", /E404/);
  assert.match(report.items[0]?.action ?? "", /npm install --legacy-peer-deps/);
  assert.equal(item(report, "CLIProxyAPI server")?.status, "manual");
  assert.match(item(report, "CLIProxyAPI server")?.action ?? "", /Start the CLIProxyAPI server/);
  assert.equal(item(report, "CLIProxyAPI API key")?.status, "manual");
});

test("install-deps inside an npm-installed package does not run npm", async (t) => {
  const s = setup(t, { installed: false, packageDir: join("node_modules", "pi-cliproxyapi-bundle") });
  let ran = false;
  const fetch = (async () => new Response("{}")) as typeof globalThis.fetch;
  const report = await installCliproxyapi(options(s, { CLIPROXYAPI_API_KEY: KEY }, { fetch, run: async () => { ran = true; return { code: 0, stdout: "", stderr: "" }; } }));
  assert.equal(ran, false);
  assert.equal(report.items[0]?.status, "manual");
  assert.match(report.items[0]?.action ?? "", /pi update --extensions/);
});

test("an install already running is reused", async (t) => {
  const s = setup(t);
  const fetch = (async () => new Response("{}")) as typeof globalThis.fetch;
  const provider = createCliproxyapiDependencyProvider(options(s, { CLIPROXYAPI_API_KEY: KEY }, { fetch }));
  const first = provider.install({});
  assert.equal(provider.install({}), first);
  await first;
});

test("the provider answers the umbrella synchronously; /cliproxyapi doctor and install-deps notify the report", async (t) => {
  const s = setup(t);
  const server = await serve(t, gateway);
  const handlers: ((data: unknown) => void)[] = [];
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void>; description?: string; getArgumentCompletions?: (prefix: string) => unknown }>();
  const pi = { events: { on: (channel: string, handler: (data: unknown) => void) => { assert.equal(channel, DEPENDENCY_CHANNEL); handlers.push(handler); return () => {}; } },
    registerCommand: (name: string, command: never) => { commands.set(name, command); } };
  registerCliproxyapiCommand(pi as never, options(s, { CLIPROXYAPI_BASE_URL: server.url, CLIPROXYAPI_API_KEY: KEY }, { run: async () => { throw new Error("must not run"); } }));
  const provided: DependencyProvider[] = [];
  for (const handler of handlers) handler({ version: 1, provide: (provider: DependencyProvider) => provided.push(provider) });
  assert.deepEqual(provided.map((provider) => [provider.id, provider.label, provider.command]), [["cliproxyapi", "pi-cliproxyapi-bundle", "/cliproxyapi"]]);

  const command = commands.get("cliproxyapi")!;
  assert.match(command.description ?? "", /doctor \| install-deps/);
  const notes: [string, string | undefined][] = [];
  const statuses: (string | undefined)[] = [];
  const ctx = { ui: { notify: (text: string, level?: string) => notes.push([text, level]), setStatus: (_key: string, text: string | undefined) => statuses.push(text) } };
  await command.handler("doctor", ctx);
  assert.match(notes.at(-1)![0], /^pi-cliproxyapi-bundle doctor: healthy\n {2}\[ok\] CLIProxyAPI provider: bundled copy loaded/);
  assert.equal(notes.at(-1)![1], "info");
  await command.handler(" install-deps ", ctx);
  assert.match(notes.at(-1)![0], /^pi-cliproxyapi-bundle install-deps: already available\n {2}Installs only the bundled npm dependency/);
  assert.match(notes.at(-1)![0], /\[ok\] npm dependencies: already installed/);
  assert.equal(statuses.at(-1), undefined, "progress status cleared");
  await command.handler("", ctx);
  assert.deepEqual(notes.at(-1), ["Usage: /cliproxyapi doctor (check the provider, CLIProxyAPI server and API key) | /cliproxyapi install-deps", "info"]);
  await command.handler("refresh", ctx);
  assert.equal(notes.at(-1)![1], "warning");
  assert.deepEqual((command.getArgumentCompletions!("") as { value: string }[]).map((entry) => entry.value), ["doctor", "install-deps"]);
  assert.deepEqual((command.getArgumentCompletions!("d") as { value: string }[]).map((entry) => entry.value), ["doctor"]);
  assert.equal(command.getArgumentCompletions!("x"), null);
});
