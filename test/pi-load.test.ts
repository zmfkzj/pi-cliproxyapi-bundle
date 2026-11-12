// Real loading: Pi's resource loader loads this package (and through it pi-cliproxyapi-provider from node_modules) in an
// isolated home and agent directory. A local stand-in for CLIProxyAPI serves the OpenAI-style model list (`/v1/models`)
// with a dummy key, so the provider registers models without any real credential or inference request.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { PACKAGE_NAME } from "../src/index.ts";
import { isolateProvider } from "./helpers/offline-provider.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = { object: "list", data: [
  { id: "gpt-6-astra", object: "model", owned_by: "openai" },
  { id: "claude-opus-4-6", object: "model", owned_by: "anthropic" },
  { id: "fake-model", object: "model", owned_by: "local" },
] };

async function start(t: TestContext, options: { separateInstall?: boolean; loadSeparate?: boolean; bundled?: string; config?: Record<string, unknown> } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi cliproxyapi it "));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  if (options.separateInstall) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [`npm:${PACKAGE_NAME}`] }));
  const requests: { url: string; auth: string | undefined }[] = [];
  const server: Server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", auth: request.headers.authorization });
    if (request.url === "/v1/models") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(CATALOG)); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const restore = isolateProvider(t, root, agentDir, `http://127.0.0.1:${port}/v1`, options.bundled ?? "auto");
  if (options.config) {
    mkdirSync(join(root, ".pi", "agent", "pi-cliproxyapi-provider"), { recursive: true });
    writeFileSync(join(root, ".pi", "agent", "pi-cliproxyapi-provider", "config.json"), JSON.stringify(options.config));
  }
  let session: AgentSession | undefined;
  t.after(async () => {
    try {
      await session?.abort();
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session?.dispose();
      server.closeAllConnections();
      await new Promise<void>(done => server.close(() => done()));
      rmSync(root, { recursive: true, force: true });
      restore();
    }
  });
  const settingsManager = SettingsManager.inMemory({});
  // loadSeparate: also load the provider package itself, as Pi does for the separate `npm:` install in the settings.
  const providerDir = dirname(fileURLToPath(import.meta.resolve(`${PACKAGE_NAME}/package.json`)));
  const paths = [packageDir, ...(options.loadSeparate ? [providerDir] : [])];
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, additionalExtensionPaths: paths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  ({ session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root) }));
  const errors: string[] = [];
  await session.bindExtensions({ onError: error => errors.push(String((error as { error?: unknown }).error ?? error)) });
  const discover = async (provider: string) => {
    const result = await session!.modelRuntime.refresh({ providers: [provider], allowNetwork: true, force: true });
    assert.deepEqual([...result.errors.entries()].map(([id, error]) => `${id}: ${String(error)}`), []);
  };
  return { loader, session, errors, requests, discover, port };
}

const commandNames = (session: AgentSession) => session.extensionRunner.getRegisteredCommands().map(command => command.invocationName);

test("the provider loads through the bundle, discovers cpa models and routes them per model family", { timeout: 60_000 }, async (t) => {
  const h = await start(t);
  assert.deepEqual(h.loader.getExtensions().errors, []);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(commandNames(h.session).sort(), ["cliproxyapi", "cliproxyapi-bundle"], "the provider's /cliproxyapi and the bundle's own command, unsuffixed");
  const upstream = h.session.extensionRunner.getRegisteredCommands().find(command => command.name === "cliproxyapi");
  assert.match(upstream?.description ?? "", /Configure, refresh, and inspect the CLIProxyAPI provider/);
  await h.discover("cpa");
  const origin = `http://127.0.0.1:${h.port}`;
  const route = (id: string) => { const model = h.session.modelRuntime.getModel("cpa", id); assert.ok(model, `cpa/${id}`); return [model.api, model.baseUrl]; };
  assert.deepEqual(route("gpt-6-astra"), ["openai-responses", `${origin}/v1`]);
  assert.deepEqual(route("claude-opus-4-6"), ["anthropic-messages", origin], "Anthropic Messages appends /v1/messages itself");
  assert.deepEqual(route("fake-model"), ["openai-completions", `${origin}/v1`]);
  assert.equal(h.session.modelRuntime.getModel("cpa", "gpt-6-astra")?.contextWindow, 272_000, "canonical Codex context window by default");
  assert.ok(h.requests.length > 0 && h.requests.every(request => request.url === "/v1/models" && request.auth === "Bearer dummy-test-key"), JSON.stringify(h.requests));
  assert.equal(h.session.modelRuntime.getModel("cliproxyapi", "gpt-6-astra"), undefined, "the former provider id is not used by default");
});

test("migration: providerName in the provider's config keeps cliproxyapi/<model> ids", { timeout: 60_000 }, async (t) => {
  const h = await start(t, { config: { providerName: "cliproxyapi" } });
  assert.deepEqual(h.errors, []);
  await h.discover("cliproxyapi");
  assert.equal(h.session.modelRuntime.getModel("cliproxyapi", "gpt-6-astra")?.api, "openai-responses");
  assert.equal(h.session.modelRuntime.getModel("cpa", "gpt-6-astra"), undefined);
});

test("with the package also installed on its own, the bundle loads nothing (no duplicate provider or commands)", { timeout: 60_000 }, async (t) => {
  const h = await start(t, { separateInstall: true });
  assert.deepEqual(h.errors, []);
  assert.deepEqual(commandNames(h.session), ["cliproxyapi-bundle"], "only the maintenance command; the separate install brings /cliproxyapi");
  assert.equal(h.session.modelRuntime.getProviders().some(provider => provider.id === "cpa"), false);
  assert.deepEqual(h.requests, []);
  const text = await doctor(h);
  assert.match(text, /^pi-cliproxyapi-bundle doctor: healthy\n/);
  assert.match(text, /\[ok\] CLIProxyAPI provider: the separate install is active \(.*settings\.json\); the bundled copy is not loaded/);
  assert.match(text, /\[ok\] CLIProxyAPI server: models endpoint reachable at http:\/\/127\.0\.0\.1:\d+, API key accepted/);
  assert.ok(!text.includes("dummy-test-key"), "the key is never shown");
});

test("bundle and separate install loaded together: every command and the provider exist exactly once", { timeout: 60_000 }, async (t) => {
  const h = await start(t, { separateInstall: true, loadSeparate: true });
  assert.deepEqual(h.loader.getExtensions().errors, []);
  assert.deepEqual(h.errors, []);
  assert.deepEqual(commandNames(h.session).sort(), ["cliproxyapi", "cliproxyapi-bundle"]);
  assert.equal(h.session.modelRuntime.getProviders().filter(provider => provider.id === "cpa").length, 1);
  await h.discover("cpa");
  assert.ok(h.session.modelRuntime.getModel("cpa", "fake-model"), "the separate install registers the models");
});

test("PI_CLIPROXYAPI_BUNDLED=off loads no provider but keeps /cliproxyapi-bundle, whose doctor says why", { timeout: 60_000 }, async (t) => {
  const h = await start(t, { bundled: "off" });
  assert.deepEqual(h.errors, []);
  assert.deepEqual(commandNames(h.session), ["cliproxyapi-bundle"]);
  assert.equal(h.session.modelRuntime.getProviders().some(provider => provider.id === "cpa"), false);
  const text = await doctor(h);
  assert.match(text, /^pi-cliproxyapi-bundle doctor: manual action required\n/);
  assert.match(text, /\[manual\] CLIProxyAPI provider: not loaded: PI_CLIPROXYAPI_BUNDLED=off, and no separate install\n {6}-> Unset PI_CLIPROXYAPI_BUNDLED/);
});

/** Run the registered `/cliproxyapi-bundle doctor` and return its notification. */
async function doctor(h: Awaited<ReturnType<typeof start>>): Promise<string> {
  const command = h.session.extensionRunner.getRegisteredCommands().find(entry => entry.name === "cliproxyapi-bundle");
  assert.ok(command, "/cliproxyapi-bundle registered");
  const notes: string[] = [];
  await command.handler("doctor", { ui: { notify: (text: string) => notes.push(text), setStatus: () => {} } } as never);
  assert.equal(notes.length, 1);
  return notes[0]!;
}
