import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";

/** Isolate the real provider's configuration; never substitute its stream or HTTP response. */
export function isolateProvider(t: TestContext, agentDir: string, baseUrl: string, bundled = "on"): () => void {
  const env: NodeJS.ProcessEnv = {
    PI_CODING_AGENT_DIR: agentDir,
    PI_CLIPROXYAPI_BUNDLED: bundled,
    CLIPROXYAPI_BASE_URL: baseUrl,
    CLIPROXYAPI_API_KEY: "dummy-test-key",
    CLIPROXYAPI_PROVIDER_ID: "cliproxyapi",
    CLIPROXYAPI_PROVIDER_NAME: "CLIProxyAPI",
    CLIPROXYAPI_FAST: "off",
    CLIPROXYAPI_TRANSPORT: "sse",
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "",
    http_proxy: "", https_proxy: "", all_proxy: "",
    NO_PROXY: "*", no_proxy: "*",
  };
  const saved = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);

  // Upstream otherwise fetches models.dev while loading, even with a loopback model catalog.
  // Seed its on-disk cache with synthetic pricing, not a live catalog or credentials.
  mkdirSync(join(agentDir, "tmp"), { recursive: true });
  writeFileSync(join(agentDir, "tmp", "models-dev-cache.json"), JSON.stringify({
    timestamp: Date.now(),
    providers: { openai: { models: { "fake-model": { cost: { input: 2, output: 4, cache_read: 1, cache_write: 3 } } } } },
  }));

  const origin = new URL(baseUrl).origin;
  assert.equal(new URL(baseUrl).hostname, "127.0.0.1");
  const blocked: string[] = [];
  const realFetch = globalThis.fetch;
  const guard = t.mock.method(globalThis, "fetch", ((input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== origin) {
      blocked.push(`${url.origin}${url.pathname}`);
      throw new Error(`Offline provider test blocked fetch to ${url.origin}`);
    }
    // A redirect must not escape the loopback boundary either.
    return realFetch(input, { ...init, redirect: "error" });
  }) as typeof fetch);

  return () => {
    guard.mock.restore();
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    assert.deepEqual(blocked, [], "no non-loopback requests (including pricing/model catalogs)");
  };
}
