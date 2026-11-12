import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { TestContext } from "node:test";

/**
 * Isolate the real provider's configuration; never substitute its stream or HTTP response.
 * pi-cliproxyapi-provider reads `~/.pi/agent/pi-cliproxyapi-provider/config.json` and keeps its snapshots under
 * `~/.cache/pi-cliproxyapi-provider/` relative to the home directory (not PI_CODING_AGENT_DIR), so HOME moves to `home`
 * too; every CLIPROXYAPI_* variable of the caller is removed first. Startup never fetches models.dev: metadata comes from
 * the package's bundled fallback catalog.
 */
export function isolateProvider(t: TestContext, home: string, agentDir: string, baseUrl: string, bundled = "on"): () => void {
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    PI_CODING_AGENT_DIR: agentDir,
    PI_CLIPROXYAPI_BUNDLED: bundled,
    CLIPROXYAPI_BASE_URL: baseUrl,
    CLIPROXYAPI_API_KEY: "dummy-test-key",
    HTTP_PROXY: "", HTTPS_PROXY: "", ALL_PROXY: "",
    http_proxy: "", https_proxy: "", all_proxy: "",
    NO_PROXY: "*", no_proxy: "*",
  };
  const names = [...new Set([...Object.keys(env), ...Object.keys(process.env).filter(name => name.startsWith("CLIPROXYAPI_"))])];
  const saved = Object.fromEntries(names.map(key => [key, process.env[key]]));
  for (const name of names) delete process.env[name];
  Object.assign(process.env, env);
  mkdirSync(join(home, ".pi", "agent"), { recursive: true });

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
