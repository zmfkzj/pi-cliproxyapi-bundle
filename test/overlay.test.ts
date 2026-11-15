// The source overlay of pi-cliproxyapi-provider (src/overlay.ts, overlay/): the routing-prefix metadata fix in
// src/matching.ts, checked through the provider's own buildProviderModels in a generated copy of the installed package,
// against an unmodified copy of the same package. The real Pi loader and stream paths are covered in pi-load.test.ts
// and pi-stream.test.ts.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { upstreamPackageDir } from "../src/index.ts";
import { changedUpstreamFiles, prepareProviderOverlay, readOverlayManifest } from "../src/overlay.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const providerDir = upstreamPackageDir();
const root = mkdtempSync(join(tmpdir(), "pi-cliproxyapi-overlay-"));
test.after(() => rmSync(root, { recursive: true, force: true }));

const prepared = prepareProviderOverlay({ providerDir, targetRoot: join(root, "overlay") });
assert.equal(prepared.status, "applied", JSON.stringify(prepared));
const patchedDir = (prepared as { dir: string }).dir;
// An unmodified copy outside node_modules, so Node can load its TypeScript the same way.
const baselineDir = join(root, "baseline");
cpSync(providerDir, baselineDir, { recursive: true });

type Model = { id: string; name: string; reasoning: boolean; api?: string; thinkingLevelMap?: Record<string, string | null>; input: string[]; cost: unknown; contextWindow: number; maxTokens: number };
type Built = { models: Model[]; stats: { unmatchedModelIds: string[]; matchMethods: Record<string, number> } };
type Build = (cpa: { id: string; owned_by?: string }[], catalog: Record<string, unknown>, aliases: Record<string, string>,
  mode?: string, overrides?: Record<string, unknown>, fallback?: string | null) => Built;
type Match = (cpa: { id: string; owned_by?: string }, catalog: Record<string, unknown>, aliases: Record<string, string>, fallback?: string | null)
  => { metadataId: string; method: string } | undefined;

const load = async (dir: string) => ({
  build: (await import(pathToFileURL(join(dir, "src", "provider.ts")).href)).buildProviderModels as Build,
  match: (await import(pathToFileURL(join(dir, "src", "matching.ts")).href)).findMetadataMatch as Match,
});
const patched = await load(patchedDir);
const baseline = await load(baselineDir);

const meta = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: id, sourceProvider: id.split("/")[0], ...extra });
const OPUS = meta("anthropic/claude-opus-5-5", {
  name: "Claude Opus 5.5", reasoning: true,
  reasoning_options: [{ type: "effort", values: ["low", "medium", "high", "xhigh", "max"] }],
  modalities: { input: ["text", "image"], output: ["text"] },
  limit: { context: 1_000_000, output: 128_000 },
  cost: { input: 4, output: 20, cache_read: 0.2, cache_write: 5 },
});
const CATALOG: Record<string, unknown> = {
  "anthropic/claude-opus-5-5": OPUS,
  "openai/gpt-x": meta("openai/gpt-x", { reasoning: true, limit: { context: 400_000, output: 64_000 } }),
  "google/dup-model": meta("google/dup-model", { limit: { context: 1, output: 1 } }),
  "mistral/dup-model": meta("mistral/dup-model", { limit: { context: 2, output: 2 } }),
  "openrouter/fb-model": meta("openrouter/fb-model", { limit: { context: 3, output: 3 } }),
  "vercel/fb-model": meta("vercel/fb-model", { limit: { context: 4, output: 4 } }),
  "bts/exact-key": meta("bts/exact-key", { limit: { context: 5, output: 5 } }),
};
const one = (build: Build, id: string, owned_by?: string, aliases: Record<string, string> = {}, overrides: Record<string, unknown> = {}, fallback: string | null = "openrouter") => {
  const built = build([{ id, ...(owned_by ? { owned_by } : {}) }], CATALOG, aliases, "canonical", overrides, fallback);
  return { model: built.models[0]!, unmatched: built.stats.unmatchedModelIds };
};

test("reported failure: bts/claude-opus-5-5 gets the Anthropic metadata, thinking map included, and keeps its id", () => {
  const before = one(baseline.build, "bts/claude-opus-5-5", "anthropic");
  assert.equal(before.model.reasoning, false, "upstream 0.16.13 leaves the routed id on defaults");
  assert.deepEqual(before.unmatched, ["bts/claude-opus-5-5"]);

  const { model, unmatched } = one(patched.build, "bts/claude-opus-5-5", "anthropic");
  assert.deepEqual(unmatched, []);
  assert.equal(model.id, "bts/claude-opus-5-5", "the request to the proxy still names the routed id");
  assert.equal(model.reasoning, true);
  assert.equal(model.api, "anthropic-messages");
  assert.deepEqual(model.thinkingLevelMap, { minimal: null, low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max", off: null });
  assert.deepEqual(model.input, ["text", "image"]);
  assert.deepEqual(model.cost, { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 });
  assert.equal(model.contextWindow, 1_000_000);
  assert.equal(model.maxTokens, 128_000);
  const plain = one(patched.build, "claude-opus-5-5", "anthropic").model;
  assert.deepEqual({ ...model, id: plain.id }, plain, "the same model as the unprefixed id, apart from the id");
});

test("the full id keeps every upstream rule first: alias, exact key, and an alias of the remainder only when nothing matched", () => {
  assert.deepEqual(patched.match({ id: "bts/claude-opus-5-5", owned_by: "anthropic" }, CATALOG, { "bts/claude-opus-5-5": "openai/gpt-x" }),
    { metadataId: "openai/gpt-x", metadata: CATALOG["openai/gpt-x"], method: "alias" }, "an alias of the routed id wins");
  assert.equal(patched.match({ id: "bts/exact-key", owned_by: "anthropic" }, CATALOG, {})?.metadataId, "bts/exact-key", "an exact catalog key wins");
  assert.equal(patched.match({ id: "bts/claude-opus-5-5", owned_by: "anthropic" }, CATALOG, { "bts/claude-opus-5-5": "missing/key" })?.metadataId,
    "anthropic/claude-opus-5-5", "an alias to a missing key is ignored, as upstream does, and the remainder resolves");
  assert.deepEqual(patched.match({ id: "bts/my-claude", owned_by: "local" }, CATALOG, { "my-claude": "anthropic/claude-opus-5-5" }),
    { metadataId: "anthropic/claude-opus-5-5", metadata: OPUS, method: "alias" }, "an alias of the remainder applies to its routed ids");
  assert.equal(patched.match({ id: "bts/claude-opus-5-5", owned_by: "anthropic" }, CATALOG, { "claude-opus-5-5": "openai/gpt-x" })?.metadataId,
    "openai/gpt-x", "the remainder resolves exactly like the unprefixed id, its alias included");
});

test("nested and provider-qualified prefixes are removed one segment at a time", () => {
  assert.equal(patched.match({ id: "team/bts/claude-opus-5-5", owned_by: "anthropic" }, CATALOG, {})?.metadataId, "anthropic/claude-opus-5-5");
  assert.deepEqual(patched.match({ id: "bts/anthropic/claude-opus-5-5", owned_by: "cpa" }, CATALOG, {}),
    { metadataId: "anthropic/claude-opus-5-5", metadata: OPUS, method: "exact" }, "a provider-qualified remainder meets its catalog key first");
  for (const id of ["bts/", "bts//", "/"]) assert.equal(patched.match({ id, owned_by: "anthropic" }, CATALOG, {}), undefined, id);
});

test("ambiguous and unknown remainders stay unmatched; owner and fallback rules still decide", () => {
  assert.equal(patched.match({ id: "bts/dup-model", owned_by: "local" }, CATALOG, {}, null), undefined, "two providers publish dup-model");
  assert.equal(patched.match({ id: "bts/dup-model", owned_by: "google" }, CATALOG, {}, null)?.metadataId, "google/dup-model", "canonical owner");
  assert.equal(patched.match({ id: "bts/dup-model", owned_by: "mistral-proxy" }, CATALOG, {}, null)?.metadataId, "mistral/dup-model", "owner hint");
  assert.equal(patched.match({ id: "bts/fb-model", owned_by: "local" }, CATALOG, {}, "openrouter")?.method, "provider-fallback");
  assert.equal(patched.match({ id: "bts/fb-model", owned_by: "local" }, CATALOG, {}, null), undefined, "fallback disabled");
  const unknown = one(patched.build, "bts/unknown-model", "anthropic");
  assert.deepEqual(unknown.unmatched, ["bts/unknown-model"]);
  assert.equal(unknown.model.reasoning, false);
  assert.deepEqual(unknown.model, one(baseline.build, "bts/unknown-model", "anthropic").model, "defaults as before");
});

test("overrides stay keyed by the routed id and apply on top of the resolved metadata", () => {
  const { model } = one(patched.build, "bts/claude-opus-5-5", "anthropic", {}, { "bts/claude-opus-5-5": { reasoning: false, contextWindow: 272_000, maxTokens: 32_768 } });
  assert.equal(model.reasoning, false);
  assert.equal(model.contextWindow, 272_000);
  assert.equal(model.maxTokens, 32_768);
  assert.equal(model.api, "anthropic-messages");
  const other = one(patched.build, "bts/claude-opus-5-5", "anthropic", {}, { "claude-opus-5-5": { reasoning: false, contextWindow: 128_000 } }).model;
  assert.equal(other.reasoning, true, "an override of the unprefixed id does not reach the routed id");
  assert.equal(other.contextWindow, 1_000_000);
});

test("with the package's real catalog, every id the upstream rules match builds exactly as before", () => {
  const catalog = JSON.parse(readFileSync(join(providerDir, "data", "models-dev-fallback.json"), "utf8")) as Record<string, { sourceProvider?: string }>;
  const cpa = Object.keys(catalog).flatMap(key => {
    const [provider, ...rest] = key.split("/");
    return [{ id: rest.join("/"), owned_by: provider! }, { id: key, owned_by: provider! }];
  });
  const before = baseline.build(cpa, catalog, {}, "canonical", {}, "openrouter");
  const after = patched.build(cpa, catalog, {}, "canonical", {}, "openrouter");
  const unmatched = new Set(before.stats.unmatchedModelIds);
  const changed = before.models.filter((model, index) => !unmatched.has(model.id) && JSON.stringify(model) !== JSON.stringify(after.models[index]));
  assert.deepEqual(changed.map(model => model.id), []);
  assert.ok(after.stats.unmatchedModelIds.every(id => unmatched.has(id)), "nothing upstream matched becomes unmatched");

  const routed = patched.build([{ id: "bts/claude-opus-5-5", owned_by: "anthropic" }, { id: "claude-opus-5-5", owned_by: "anthropic" }], catalog, {}, "canonical", {}, "openrouter");
  assert.deepEqual(routed.stats.unmatchedModelIds, []);
  assert.equal(routed.models[0]!.reasoning, true);
  assert.deepEqual({ ...routed.models[0]!, id: "claude-opus-5-5" }, routed.models[1], "the routed id gets the real Anthropic entry");
});

test("guard: the overlay applies only to the upstream file it was written for, and the locked version is that file", () => {
  const manifest = readOverlayManifest();
  assert.deepEqual(changedUpstreamFiles(providerDir, manifest), [],
    "the installed provider changed a file the overlay replaces: port overlay/ to it (overlay/README.md) before updating");
  const lock = JSON.parse(readFileSync(join(packageDir, "package-lock.json"), "utf8")) as { packages: Record<string, { version: string }> };
  const installed = JSON.parse(readFileSync(join(providerDir, "package.json"), "utf8")) as { version: string };
  assert.equal(installed.version, lock.packages["node_modules/pi-cliproxyapi-provider"]!.version);

  const changed = join(root, "changed-provider");
  cpSync(providerDir, changed, { recursive: true });
  writeFileSync(join(changed, "src", "matching.ts"), `${readFileSync(join(changed, "src", "matching.ts"), "utf8")}\n// upstream change\n`);
  const skipped = prepareProviderOverlay({ providerDir: changed, targetRoot: join(root, "skipped") });
  assert.equal(skipped.status, "skipped");
  assert.match(skipped.detail, /changed src\/matching\.ts since the overlay was written for 0\.16\.13; the unmodified provider is loaded/);
  assert.equal(existsSync(join(root, "skipped")), false, "nothing is generated");

  const other = join(root, "other-package");
  mkdirSync(other);
  writeFileSync(join(other, "package.json"), JSON.stringify({ name: "something-else", version: "1.0.0" }));
  assert.equal(prepareProviderOverlay({ providerDir: other, targetRoot: join(root, "other") }).status, "skipped");
});

test("the generated copy is reused, replaces only the listed file, and old copies are removed after a day", () => {
  const target = join(root, "reuse");
  const first = prepareProviderOverlay({ providerDir, targetRoot: target });
  assert.equal(first.status, "applied");
  const dir = (first as { dir: string }).dir;
  const stamp = statSync(join(dir, ".overlay.json")).mtimeMs;
  assert.deepEqual(prepareProviderOverlay({ providerDir, targetRoot: target }), first);
  assert.equal(statSync(join(dir, ".overlay.json")).mtimeMs, stamp, "not rebuilt");
  assert.equal(readFileSync(join(dir, "src", "matching.ts"), "utf8"), readFileSync(join(packageDir, "overlay", "pi-cliproxyapi-provider", "src", "matching.ts"), "utf8"));
  for (const file of ["src/provider.ts", "src/catalog.ts", "extensions/index.ts", "data/models-dev-fallback.json", "LICENSE", "package.json"]) {
    assert.ok(readFileSync(join(dir, file)).equals(readFileSync(join(providerDir, file))), `${file} is the installed copy`);
  }

  const stale = join(target, "0.0.1-old"), fresh = join(target, "0.0.2-recent");
  mkdirSync(stale); mkdirSync(fresh);
  const old = new Date(Date.now() - 2 * 86_400_000);
  utimesSync(stale, old, old);
  rmSync(join(dir, ".overlay.json"));
  assert.equal(prepareProviderOverlay({ providerDir, targetRoot: target }).status, "applied", "a copy without its stamp is rebuilt");
  assert.equal(existsSync(stale), false);
  assert.equal(existsSync(fresh), true, "a copy a running Pi may still use is kept");
});

test("the overlaid matching.ts typechecks against the package it is copied into", { timeout: 120_000 }, () => {
  // The production location (<bundle>/.provider-overlay), where the provider's Pi peers resolve.
  const production = prepareProviderOverlay({ providerDir });
  assert.equal(production.status, "applied", JSON.stringify(production));
  const copy = (production as { dir: string }).dir;
  const tsc = join(packageDir, "node_modules", "typescript", "bin", "tsc");
  const result = spawnSync(process.execPath, [tsc, "--ignoreConfig", "--noEmit", "--strict", "--target", "ES2023", "--module", "NodeNext",
    "--moduleResolution", "NodeNext", "--allowImportingTsExtensions", "--verbatimModuleSyntax", "--erasableSyntaxOnly", "--skipLibCheck",
    "--types", "node", "--typeRoots", join(packageDir, "node_modules", "@types"),
    join(copy, "src", "matching.ts"), join(copy, "src", "provider.ts")], { cwd: packageDir, encoding: "utf8" });
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
});
