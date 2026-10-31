// The provider's patched Codex module (src/codex-cache.ts) under concurrent Pi starts, broken cache files and processes
// that still write the shared cache in place (an older bundle, a separate install of the provider).
// Scenarios run real, separate Pi processes (test/helpers/codex-cache-child.ts) through Pi's resource loader and this
// package's real entry, sharing one cache directory (TMPDIR), and stream a reply through the registered `cliproxyapi`
// adapter from a loopback server: the provider only warns when its patched module fails to load, so loading alone would not
// show the failure.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync, writeSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import test, { after } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createCliproxyapiBundle } from "../src/index.ts";
import { protectCodexModule, publishAtomically, STALE_TEMP_MS, type CodexCacheApi } from "../src/codex-cache.ts";

const packageDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHILD = join(packageDir, "test", "helpers", "codex-cache-child.ts");
const CACHE = "pi-cliproxyapi-provider";
const REPLY = "Hello from the offline fixture.";
const USAGE = { input_tokens: 5, input_tokens_details: { cached_tokens: 0 }, output_tokens: 4, total_tokens: 9 };

const root = mkdtempSync(join(tmpdir(), "pi cliproxyapi cache "));

function frames(): string {
  const item = { type: "message", id: "msg_1", role: "assistant", content: [], status: "in_progress" };
  return [
    { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_text.delta", output_index: 0, item_id: item.id, delta: REPLY },
    { type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed", content: [{ type: "output_text", text: REPLY }] } },
    { type: "response.completed", response: { id: "resp_1", status: "completed", usage: USAGE } },
  ].map(frame => `event: ${frame.type}\ndata: ${JSON.stringify(frame)}\n\n`).join("") + "data: [DONE]\n\n";
}

const server: Server = createServer((request, response) => {
  if (request.url === "/proxy/v1/models?client_version=pi") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ models: [{ slug: "fake-model", display_name: "Fake", context_window: 100_000, input_modalities: ["text"] }] }));
    return;
  }
  if (request.url === "/proxy/backend-api/codex/responses") {
    request.resume();
    request.on("end", () => { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(frames()); });
    return;
  }
  response.writeHead(404); response.end();
});
await new Promise<void>(done => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
after(async () => {
  server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
  rmSync(root, { recursive: true, force: true });
});

interface ChildResult { text?: string; stopReason?: string; errorMessage?: string; warnings: string[]; errors?: string[]; fatal?: string }

/** Starts `count` Pi processes on one cache directory; they all pass the barrier together once `release` resolves. */
async function startTogether(tmp: string, count: number, release: () => Promise<void> = async () => {}, providerId = "cliproxyapi"): Promise<ChildResult[]> {
  const run = mkdtempSync(join(root, "run "));
  const ready = join(run, "ready");
  const go = join(run, "go");
  mkdirSync(ready);
  const children = Array.from({ length: count }, (_, index) => {
    const agentDir = join(run, `agent-${index}`);
    mkdirSync(agentDir);
    // A plain process (not a node:test subprocess), sharing the cache directory through TMPDIR.
    const env: NodeJS.ProcessEnv = { ...process.env, TMPDIR: tmp };
    delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [CHILD, packageDir, agentDir, origin, ready, go, providerId], { env, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", chunk => { out += chunk; });
    child.stderr.on("data", chunk => { err += chunk; });
    return new Promise<ChildResult>(done => child.on("close", code => {
      try { done(JSON.parse(out.trim().split("\n").at(-1) ?? "") as ChildResult); } catch { done({ fatal: `exit ${code}: ${out}${err}`.slice(0, 4000), warnings: [] }); }
    }));
  });
  for (const deadline = Date.now() + 60_000; readdirSync(ready).length < count;) {
    assert.ok(Date.now() < deadline, "children did not reach the start barrier");
    await sleep(10);
  }
  await release();
  writeFileSync(go, "");
  return Promise.all(children);
}

/** Every process streamed the reply through the patched module. `allow`: warnings expected in the scenario. */
function assertStreamed(results: ChildResult[], allow?: RegExp): void {
  for (const [index, result] of results.entries()) {
    assert.equal(result.fatal, undefined, `process ${index}: ${result.fatal} (warnings: ${result.warnings.join(" / ")})`);
    assert.deepEqual(result.warnings.filter(line => /codex|cache/i.test(line) && !allow?.test(line)), [], `process ${index} warnings`);
    assert.deepEqual(result.errors, [], `process ${index} extension errors`);
    assert.equal(result.errorMessage, undefined, `process ${index}: ${result.errorMessage}`);
    assert.equal(result.stopReason, "stop", `process ${index}`);
    assert.equal(result.text, REPLY, `process ${index}`);
  }
}

const freshTmp = () => mkdtempSync(join(root, "tmp "));
const cacheFiles = (tmp: string) => readdirSync(join(tmp, CACHE)).sort();

/** The provider's own cache file for this host: name and contents, from one uncontended start on an empty cache. */
let referenceRun: Promise<{ name: string; contents: string; files: string[] }> | undefined;
function reference() {
  return referenceRun ??= (async () => {
    const tmp = freshTmp();
    assertStreamed(await startTogether(tmp, 1));
    const files = cacheFiles(tmp);
    return { name: files[0]!, contents: readFileSync(join(tmp, CACHE, files[0]!), "utf8"), files };
  })();
}

test("one start on an empty cache publishes exactly the file the provider imports", { timeout: 120_000 }, async () => {
  const { name, contents, files } = await reference();
  // One file only: the provider imported the file the bundle published (it writes its own when the paths differ).
  assert.deepEqual(files, [name]);
  assert.match(contents, /streamSimple/);
});

function seeded(name: string, contents: string): string {
  const tmp = freshTmp();
  mkdirSync(join(tmp, CACHE));
  writeFileSync(join(tmp, CACHE, name), contents);
  return tmp;
}

test("an empty cache file left by another process is replaced before the provider imports it", { timeout: 120_000 }, async () => {
  const ref = await reference();
  const tmp = seeded(ref.name, "");
  assertStreamed(await startTogether(tmp, 1));
  assert.deepEqual(cacheFiles(tmp), [ref.name]);
  assert.equal(readFileSync(join(tmp, CACHE, ref.name), "utf8"), ref.contents);
});

test("a half-written cache file is replaced before the provider imports it", { timeout: 120_000 }, async () => {
  const ref = await reference();
  const tmp = seeded(ref.name, ref.contents.slice(0, Math.floor(ref.contents.length / 2)));
  assertStreamed(await startTogether(tmp, 1));
  assert.equal(readFileSync(join(tmp, CACHE, ref.name), "utf8"), ref.contents);
});

test("a publication interrupted before its rename is redone; only stale temporary files are removed", { timeout: 120_000 }, async () => {
  const ref = await reference();
  const tmp = freshTmp();
  mkdirSync(join(tmp, CACHE));
  const stale = join(tmp, CACHE, `${ref.name}.4242.0123456789ab.tmp`);
  const inFlight = join(tmp, CACHE, `${ref.name}.4343.ba9876543210.tmp`);
  writeFileSync(stale, ref.contents.slice(0, 100));
  const old = new Date(Date.now() - STALE_TEMP_MS - 60_000);
  utimesSync(stale, old, old);
  writeFileSync(inFlight, ref.contents.slice(0, 100));
  assertStreamed(await startTogether(tmp, 1));
  assert.equal(readFileSync(join(tmp, CACHE, ref.name), "utf8"), ref.contents);
  assert.equal(existsSync(stale), false, "the dead process's temporary file is removed");
  assert.equal(existsSync(inFlight), true, "a recent temporary file may be another process's write and stays");
});

test("eight Pi processes starting together on an empty cache all stream through the patched module", { timeout: 180_000 }, async () => {
  const ref = await reference();
  const tmp = freshTmp();
  assertStreamed(await startTogether(tmp, 8));
  assert.deepEqual(cacheFiles(tmp), [ref.name], "one complete cache file, no temporary files left");
  assert.equal(readFileSync(join(tmp, CACHE, ref.name), "utf8"), ref.contents);
});

test("processes starting while an older in-place writer has written half of the file are not affected", { timeout: 180_000 }, async () => {
  // The provider's own write (writeFileSync: create/truncate, then write) as a process without this fix does it, held halfway.
  const ref = await reference();
  const tmp = freshTmp();
  mkdirSync(join(tmp, CACHE));
  const target = join(tmp, CACHE, ref.name);
  const fd = openSync(target, "w");
  const half = Buffer.from(ref.contents.slice(0, Math.floor(ref.contents.length / 2)));
  writeSync(fd, half);
  try {
    assertStreamed(await startTogether(tmp, 4));
  } finally {
    writeSync(fd, Buffer.from(ref.contents.slice(Math.floor(ref.contents.length / 2))));
    closeSync(fd);
  }
  assert.equal(readFileSync(target, "utf8"), ref.contents);
});

test("publishAtomically keeps a correct file, and a failed publication leaves the path and no temporary file", () => {
  const dir = mkdtempSync(join(root, "publish "));
  const target = join(dir, "cache", "module.mjs");
  assert.equal(publishAtomically(target, "export const a = 1;\n").action, "created");
  const inode = statSync(target).ino;
  assert.equal(publishAtomically(target, "export const a = 1;\n").action, "valid");
  assert.equal(statSync(target).ino, inode, "a correct file is not rewritten");
  writeFileSync(target, "export const a");
  assert.equal(publishAtomically(target, "export const a = 1;\n").action, "repaired");
  assert.equal(readFileSync(target, "utf8"), "export const a = 1;\n");
  // The path is a directory: the rename fails; the error is reported and the temporary file removed.
  const blocked = join(dir, "cache", "blocked.mjs");
  mkdirSync(join(blocked, "inside"), { recursive: true });
  assert.throws(() => publishAtomically(blocked, "x"));
  assert.deepEqual(readdirSync(join(dir, "cache")).sort(), ["blocked.mjs", "module.mjs"]);
});

/** Starts a process that rewrites `target` in place, as the provider's own cache write does (create/truncate, then write),
 * over and over: each round opens the current path (truncating whatever file is there now), writes half, pauses, writes
 * the rest. Returns its round counter and a function that stops it. */
function inPlaceWriter(target: string, contents: string): { rounds: () => number; stop: () => Promise<void> } {
  const stopFile = `${target}.stop-writer`;
  const counter = `${target}.writer-rounds`;
  const script = `
    const fs = require("node:fs");
    const [target, contents, stopFile, counter] = process.argv.slice(1);
    const half = Math.floor(contents.length / 2);
    const pause = new Int32Array(new SharedArrayBuffer(4));
    let rounds = 0;
    while (!fs.existsSync(stopFile)) {
      const fd = fs.openSync(target, "w");
      fs.writeSync(fd, contents.slice(0, half));
      Atomics.wait(pause, 0, 0, 5);
      fs.writeSync(fd, contents.slice(half));
      fs.closeSync(fd);
      fs.writeFileSync(counter, String(++rounds));
    }`;
  const child = spawn(process.execPath, ["-e", script, target, contents, stopFile, counter], { stdio: "ignore" });
  const exited = new Promise<void>(done => child.on("close", () => done()));
  return {
    rounds: () => { try { return Number(readFileSync(counter, "utf8")); } catch { return 0; } },
    stop: async () => { writeFileSync(stopFile, ""); await exited; },
  };
}

test("processes starting while another process keeps rewriting the shared file in place stream through the patched module", { timeout: 180_000 }, async () => {
  const ref = await reference();
  const tmp = freshTmp();
  mkdirSync(join(tmp, CACHE));
  const writer = inPlaceWriter(join(tmp, CACHE, ref.name), ref.contents);
  try {
    const results = await startTogether(tmp, 6, async () => {
      for (const deadline = Date.now() + 10_000; writer.rounds() < 3;) { assert.ok(Date.now() < deadline, "writer did not start"); await sleep(5); }
    });
    const roundsDuringStarts = writer.rounds();
    assertStreamed(results);
    assert.ok(roundsDuringStarts > 3, `the writer kept rewriting during the starts (${roundsDuringStarts} rounds)`);
  } finally {
    await writer.stop();
  }
});

test("a shared file that stays empty and cannot be replaced does not reach protected processes", { timeout: 180_000 }, async () => {
  const ref = await reference();
  const tmp = seeded(ref.name, "");
  chmodSync(join(tmp, CACHE), 0o555); // the publication's rename fails; the empty file stays for the whole run
  try {
    const results = await startTogether(tmp, 4);
    assertStreamed(results, /could not publish the shared Codex module cache/);
    for (const result of results) assert.ok(result.warnings.some(line => /could not publish the shared Codex module cache .*this process does not read it/.test(line)));
    assert.equal(readFileSync(join(tmp, CACHE, ref.name), "utf8"), "");
  } finally {
    chmodSync(join(tmp, CACHE), 0o755);
  }
});

test("a non-default provider id gets its own patched module, protected the same way", { timeout: 120_000 }, async () => {
  const ref = await reference();
  const tmp = freshTmp();
  const results = await startTogether(tmp, 2, async () => {}, "my-proxy");
  assertStreamed(results);
  const files = cacheFiles(tmp);
  assert.equal(files.length, 1);
  assert.notEqual(files[0], ref.name, "the provider id is part of the patched source");
});

// In this test process, with Node's real module hooks: what the provider's `import(<cache file>)` gets.

let seq = 0;
/** A stand-in for the provider's exports: the patched source is `source`, the cache file a fresh path under `dir`. */
function fakeApi(dir: string, source: string, fail?: string): CodexCacheApi {
  const original = join(dir, `original-${++seq}.js`);
  writeFileSync(original, "// original\n");
  const name = `openai-codex-responses-cpa-${String(seq).padStart(16, "0")}.mjs`;
  return {
    resolveOriginalCodexModulePath: () => { if (fail) throw new Error(fail); return { path: original }; },
    sharedSupportsConfigurationUpdate: () => true,
    patchCodexSource: () => source,
    computePatchedModuleCachePath: () => join(dir, CACHE, name),
    rewritePatchedModuleImports: patched => patched,
    resolveIdentity: () => ({ providerId: "cliproxyapi" }),
  };
}

test("the provider's import of the cache file gets the computed source, whatever the file holds", async () => {
  const dir = mkdtempSync(join(root, "hooks "));
  const protection = await protectCodexModule({ agentDir: dir, api: fakeApi(dir, "export const from = 'computed';\n") });
  assert.equal(protection.protected, true);
  const file = fileURLToPath(protection.url!);
  assert.equal(readFileSync(file, "utf8"), "export const from = 'computed';\n", "the shared file is published as well");
  writeFileSync(file, "export const from = 'another process';\n");
  assert.equal((await import(protection.url!)).from, "computed");
  // The provider imports by path (jiti passes it to Node's import); a missing file does not matter either.
  const second = await protectCodexModule({ agentDir: dir, api: fakeApi(dir, "export const from = 'computed 2';\n") });
  rmSync(fileURLToPath(second.url!));
  assert.equal((await import(fileURLToPath(second.url!))).from, "computed 2");
});

test("a cache file this process did not prepare is refused, not read unprotected", async () => {
  const dir = mkdtempSync(join(root, "hooks "));
  const protection = await protectCodexModule({ agentDir: dir, api: fakeApi(dir, "export const from = 'computed';\n") });
  const other = join(dir, CACHE, "openai-codex-responses-cpa-0123456789abcdef.mjs");
  writeFileSync(other, "export const from = 'file';\n");
  await assert.rejects(import(pathToFileURL(other).href), (error: Error) =>
    error.message.includes("refused to import") && error.message.includes("not the patched module this bundle prepared") && error.message.includes(protection.url!));
});

test("when the source cannot be computed, patched-module imports from the cache are refused, not read unprotected", async () => {
  const dir = mkdtempSync(join(root, "hooks "));
  const failed = await protectCodexModule({ agentDir: dir, api: fakeApi(dir, "", "Pi AI module moved") });
  assert.equal(failed.protected, false);
  assert.match(failed.reason!, /could not compute the patched Codex module \(Pi AI module moved\)/);
  const cached = join(dir, CACHE, "openai-codex-responses-cpa-fedcba9876543210.mjs");
  mkdirSync(dirname(cached), { recursive: true });
  writeFileSync(cached, "export const from = 'file';\n");
  await assert.rejects(import(pathToFileURL(cached).href), /refused to import .*could not compute the patched Codex module \(Pi AI module moved\)/);
  // Other modules load as usual.
  writeFileSync(join(dir, "other.mjs"), "export const ok = true;\n");
  assert.equal((await import(pathToFileURL(join(dir, "other.mjs")).href)).ok, true);
  // A later successful preparation (e.g. after /reload) serves its module.
  const ok = await protectCodexModule({ agentDir: dir, api: fakeApi(dir, "export const from = 'computed';\n") });
  assert.equal((await import(ok.url!)).from, "computed");
});

test("without module.registerHooks protection is impossible and protectCodexModule throws", async () => {
  const script = `import { protectCodexModule } from ${JSON.stringify(pathToFileURL(join(packageDir, "src", "codex-cache.ts")).href)};
    try { await protectCodexModule({ agentDir: "/nonexistent", registerHooks: undefined }); console.log("protected"); }
    catch (error) { console.log("threw: " + error.message); }`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
  let out = "";
  child.stdout.on("data", chunk => { out += chunk; });
  await new Promise(done => child.on("close", done));
  assert.match(out, /^threw: this runtime \(node v[\d.]+\) has no module.registerHooks/);
});

const fakePi = () => ({ registerCommand() {}, events: { emit() {}, on: () => () => {} } }) as never;

test("the bundle does not load the provider when protection is impossible", async () => {
  let loaded = 0;
  await assert.rejects(createCliproxyapiBundle({ env: { PI_CLIPROXYAPI_BUNDLED: "on" }, agentDir: root, cwd: root,
    protect: async () => { throw new Error("no module.registerHooks"); }, load: async () => [() => { loaded++; }] })(fakePi()),
  /\[pi-cliproxyapi-bundle\] not loaded: no module.registerHooks/);
  assert.equal(loaded, 0);
});

test("the bundle loads the provider with Codex streaming refused when the module cannot be computed, and says so", async (t) => {
  const warnings: string[] = [];
  t.mock.method(console, "warn", (...args: unknown[]) => { warnings.push(args.map(String).join(" ")); });
  let loaded = 0;
  await createCliproxyapiBundle({ env: { PI_CLIPROXYAPI_BUNDLED: "on" }, agentDir: root, cwd: root,
    protect: async () => ({ protected: false, reason: "could not compute the patched Codex module (x)" }), load: async () => [() => { loaded++; }] })(fakePi());
  assert.equal(loaded, 1);
  assert.deepEqual(warnings, ["[pi-cliproxyapi-bundle] Codex streaming of the provider is disabled: could not compute the patched Codex module (x)"]);
});
