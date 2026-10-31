// One Pi process for test/codex-cache.test.ts: loads this package with Pi's resource loader (the production path: bundle →
// cache preparation → the official provider → its patched Codex module from <TMPDIR>/pi-cliproxyapi-provider), waits at a
// start barrier shared with the other processes, then streams one reply from the parent's loopback server through the
// registered `cliproxyapi` adapter. Prints one JSON line: the reply, the provider's warnings and any error.
//
// argv: packageDir agentDir origin readyDir goFile [providerId]. TMPDIR comes from the parent (one cache directory for all processes).
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

const [packageDir, agentDir, origin, readyDir, goFile, providerId = "cliproxyapi"] = process.argv.slice(2) as [string, string, string, string, string, string?];
const warnings: string[] = [];
console.warn = (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); };

Object.assign(process.env, {
  PI_CODING_AGENT_DIR: agentDir, PI_CLIPROXYAPI_BUNDLED: "on",
  CLIPROXYAPI_BASE_URL: `${origin}/proxy/v1/`, CLIPROXYAPI_API_KEY: "dummy-test-key",
  CLIPROXYAPI_PROVIDER_ID: providerId, CLIPROXYAPI_PROVIDER_NAME: "CLIProxyAPI",
  CLIPROXYAPI_FAST: "off", CLIPROXYAPI_TRANSPORT: "sse",
  HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "", http_proxy: "", https_proxy: "", all_proxy: "", NO_PROXY: "*", no_proxy: "*",
});
// Synthetic pricing instead of models.dev, and no request may leave the loopback server.
mkdirSync(join(agentDir, "tmp"), { recursive: true });
writeFileSync(join(agentDir, "tmp", "models-dev-cache.json"), JSON.stringify({ timestamp: Date.now(), providers: {} }));
const realFetch = globalThis.fetch;
globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== origin) return Promise.reject(new Error(`blocked fetch to ${url.origin}`));
  return realFetch(input, { ...init, redirect: "error" });
}) as typeof fetch;

const CONTEXT: Context = { systemPrompt: "Offline cache fixture.", messages: [{ role: "user", content: "Say hello.", timestamp: 1 }] };

async function main() {
  writeFileSync(join(readyDir, String(process.pid)), "");
  while (!existsSync(goFile)) await sleep(2);
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off", enableInstallTelemetry: false, transport: "sse" });
  const loader = new DefaultResourceLoader({ cwd: agentDir, agentDir, settingsManager, additionalExtensionPaths: [packageDir],
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true });
  await loader.reload();
  const { session } = await createAgentSession({ cwd: agentDir, agentDir, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(agentDir), noTools: "builtin" });
  const errors: string[] = loader.getExtensions().errors.map(error => JSON.stringify(error));
  await session.bindExtensions({ onError: error => errors.push(String((error as { error?: unknown }).error ?? error)) });
  const model = session.modelRuntime.getModel(providerId, "fake-model");
  if (!model) throw new Error(`${providerId}/fake-model not registered`);
  let result: AssistantMessage | undefined;
  for await (const event of session.modelRuntime.streamSimple(model, CONTEXT, { transport: "sse", maxRetries: 0 })) {
    if (event.type === "done") result = event.message;
    if (event.type === "error") result = event.error;
  }
  const text = result?.content.flatMap(part => part.type === "text" ? [part.text] : []).join("") ?? "";
  session.dispose();
  return { text, stopReason: result?.stopReason, errorMessage: result?.errorMessage, warnings, errors };
}

main().then(
  out => { process.stdout.write(`${JSON.stringify(out)}\n`); process.exit(0); },
  error => { process.stdout.write(`${JSON.stringify({ fatal: String(error?.stack ?? error), warnings })}\n`); process.exit(1); },
);
