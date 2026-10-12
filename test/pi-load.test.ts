// Real loading: Pi's resource loader loads this package (and through it the official provider package from node_modules)
// in an isolated agent directory. A local stand-in for CLIProxyAPI serves the model catalog (`/v1/models?client_version=pi`)
// with a dummy key, so the provider registers models without any real credential or inference request.
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { PACKAGE_NAME } from "../src/index.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CATALOG = { models: [{ slug: "fake-model", display_name: "Fake Model", context_window: 100_000, input_modalities: ["text"], supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] }] };

async function start(t: TestContext, options: { separateInstall?: boolean; loadSeparate?: boolean } = {}) {
  const root = mkdtempSync(join(tmpdir(), "pi cliproxyapi it "));
  const agentDir = join(root, "agent");
  mkdirSync(agentDir, { recursive: true });
  if (options.separateInstall) writeFileSync(join(agentDir, "settings.json"), JSON.stringify({ packages: [`npm:${PACKAGE_NAME}`] }));
  const requests: { url: string; auth: string | undefined }[] = [];
  const server: Server = createServer((request, response) => {
    requests.push({ url: request.url ?? "", auth: request.headers.authorization });
    if (request.url?.startsWith("/v1/models")) { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify(CATALOG)); return; }
    response.writeHead(404); response.end();
  });
  await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as { port: number }).port;
  const saved = Object.fromEntries(["PI_CODING_AGENT_DIR", "CLIPROXYAPI_BASE_URL", "CLIPROXYAPI_API_KEY", "PI_CLIPROXYAPI_BUNDLED"].map(key => [key, process.env[key]]));
  Object.assign(process.env, { PI_CODING_AGENT_DIR: agentDir, CLIPROXYAPI_BASE_URL: `http://127.0.0.1:${port}`, CLIPROXYAPI_API_KEY: "dummy-test-key" });
  delete process.env.PI_CLIPROXYAPI_BUNDLED;
  const settingsManager = SettingsManager.inMemory({});
  // loadSeparate: also load the provider package itself, as Pi does for the separate `npm:` install in the settings.
  const providerDir = dirname(fileURLToPath(import.meta.resolve(`${PACKAGE_NAME}/package.json`)));
  const paths = [packageDir, ...(options.loadSeparate ? [providerDir] : [])];
  const loader = new DefaultResourceLoader({ cwd: root, agentDir, settingsManager, additionalExtensionPaths: paths, noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: root, agentDir, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root) });
  const errors: string[] = [];
  await session.bindExtensions({ onError: error => errors.push(String((error as { error?: unknown }).error ?? error)) });
  t.after(async () => {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
    await new Promise(done => server.close(done));
    for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    rmSync(root, { recursive: true, force: true });
  });
  return { loader, session, errors, requests };
}

test("the official provider loads through the bundle and registers cliproxyapi models and its commands", { timeout: 60_000 }, async (t) => {
  const h = await start(t);
  assert.deepEqual(h.loader.getExtensions().errors, []);
  assert.deepEqual(h.errors, []);
  const commands = h.session.extensionRunner.getRegisteredCommands().map(command => command.name);
  for (const name of ["fast", "pause", "continue", "cliproxyapi-refresh"]) assert.equal(commands.filter(command => command === name).length, 1, name);
  const model = h.session.modelRuntime.getModel("cliproxyapi", "fake-model");
  assert.ok(model, "cliproxyapi/fake-model registered");
  assert.equal(model.name, "Fake Model");
  assert.equal(model.contextWindow, 100_000);
  assert.ok(h.session.modelRuntime.getProviders().some(provider => provider.id === "cliproxyapi"));
  assert.ok(h.requests.some(request => request.url.startsWith("/v1/models?client_version=pi") && request.auth === "Bearer dummy-test-key"), JSON.stringify(h.requests));
  assert.ok(!h.requests.some(request => request.url.includes("/responses")), "no inference request");
});

test("with the package also installed on its own, the bundle loads nothing (no duplicate provider or commands)", { timeout: 60_000 }, async (t) => {
  const h = await start(t, { separateInstall: true });
  assert.deepEqual(h.errors, []);
  const commands = h.session.extensionRunner.getRegisteredCommands().map(command => command.name);
  assert.equal(commands.includes("fast"), false);
  assert.equal(h.session.modelRuntime.getModel("cliproxyapi", "fake-model"), undefined);
  assert.deepEqual(h.requests, []);
});

test("bundle and separate install loaded together: every command and the provider exist exactly once", { timeout: 60_000 }, async (t) => {
  const h = await start(t, { separateInstall: true, loadSeparate: true });
  assert.deepEqual(h.loader.getExtensions().errors, []);
  assert.deepEqual(h.errors, []);
  const commands = h.session.extensionRunner.getRegisteredCommands().map(command => command.name);
  for (const name of ["fast", "pause", "continue", "cliproxyapi-refresh"]) assert.equal(commands.filter(command => command === name).length, 1, name);
  assert.equal(h.session.modelRuntime.getProviders().filter(provider => provider.id === "cliproxyapi").length, 1);
  assert.ok(h.session.modelRuntime.getModel("cliproxyapi", "fake-model"), "the separate install registers the models");
});
