// scripts/update-provider.ts: version comparison against the lock, no-op, update, and every failure that must stop the
// workflow before anything is committed. npm is replaced by a recorded fake; no network.
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { compareVersions, parseVersion, plan, PROVIDER, readState, updateProvider, type Run } from "../scripts/update-provider.ts";

function fixture(t: TestContext, range = "^1.4.22", locked = "1.4.22") {
  const dir = mkdtempSync(join(tmpdir(), "pi cliproxyapi update "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const write = (nextRange: string, nextLocked: string) => {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x", dependencies: { [PROVIDER]: nextRange } }, null, 2));
    writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages: { "": {}, [`node_modules/${PROVIDER}`]: { version: nextLocked } } }, null, 2));
  };
  write(range, locked);
  return { dir, write };
}

/** A fake npm: `view` answers `latest` (or fails), `install` applies `installs` (or fails). */
function fakeNpm(options: { latest?: string; viewFails?: boolean; viewOutput?: string; installFails?: boolean; installs?: [string, string]; write?: (range: string, locked: string) => void }) {
  const calls: string[][] = [];
  const run: Run = (_command, args) => {
    calls.push(args);
    if (args[0] === "view") {
      if (options.viewFails) return { status: 1, stdout: "", stderr: "npm error code E404" };
      return { status: 0, stdout: options.viewOutput ?? JSON.stringify(options.latest), stderr: "" };
    }
    if (args[0] === "install") {
      if (options.installFails) return { status: 1, stdout: "", stderr: "npm error ERESOLVE" };
      if (options.installs) options.write?.(...options.installs);
      return { status: 0, stdout: "", stderr: "" };
    }
    return { status: 2, stdout: "", stderr: `unexpected npm ${args.join(" ")}` };
  };
  return { run, calls };
}

test("versions: release versions only, compared numerically", () => {
  assert.deepEqual(parseVersion("1.4.22"), [1, 4, 22]);
  assert.throws(() => parseVersion("1.5.0-beta.1"), /not a release version/);
  assert.throws(() => parseVersion("^1.4.22"), /not a release version/);
  assert.equal(compareVersions("1.4.22", "1.4.3"), 1);
  assert.equal(compareVersions("1.4.22", "1.5.0"), -1);
  assert.equal(compareVersions("2.0.0", "2.0.0"), 0);
});

test("plan compares with the locked version, not the range: a new minor inside ^1.4.22 is still an update", (t) => {
  const { dir } = fixture(t);
  const state = readState(dir);
  assert.deepEqual(state, { range: "^1.4.22", locked: "1.4.22" });
  assert.deepEqual(plan(state, "1.5.0"), { update: true, from: "1.4.22", to: "1.5.0", spec: `${PROVIDER}@^1.5.0` });
  assert.deepEqual(plan(state, "1.4.22"), { update: false, from: "1.4.22" });
  assert.deepEqual(plan(state, "1.4.21"), { update: false, from: "1.4.22" }, "never a downgrade");
});

test("same version: no install, no change", (t) => {
  const { dir } = fixture(t);
  const before = readFileSync(join(dir, "package-lock.json"), "utf8");
  const npm = fakeNpm({ latest: "1.4.22" });
  assert.deepEqual(updateProvider(dir, { run: npm.run }), { updated: false, from: "1.4.22", version: "1.4.22" });
  assert.deepEqual(npm.calls.map(args => args[0]), ["view"]);
  assert.equal(readFileSync(join(dir, "package-lock.json"), "utf8"), before);
});

test("newer version: one npm install of ^latest, and package.json + lock must both end at it", (t) => {
  const f = fixture(t);
  const npm = fakeNpm({ latest: "1.5.0", installs: ["^1.5.0", "1.5.0"], write: f.write });
  assert.deepEqual(updateProvider(f.dir, { run: npm.run }), { updated: true, from: "1.4.22", version: "1.5.0" });
  assert.deepEqual(npm.calls[1], ["install", "--save", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", `${PROVIDER}@^1.5.0`]);
  assert.deepEqual(readState(f.dir), { range: "^1.5.0", locked: "1.5.0" });
});

test("dry run reports the update without installing", (t) => {
  const { dir } = fixture(t);
  const npm = fakeNpm({ latest: "1.5.0" });
  assert.deepEqual(updateProvider(dir, { run: npm.run, dryRun: true }), { updated: true, from: "1.4.22", version: "1.5.0" });
  assert.deepEqual(npm.calls.map(args => args[0]), ["view"]);
});

test("every failure throws, so the workflow stops before typecheck, tests and commit", (t) => {
  const f = fixture(t);
  assert.throws(() => updateProvider(f.dir, { run: fakeNpm({ viewFails: true }).run }), /npm view .* failed: npm error code E404/);
  assert.throws(() => updateProvider(f.dir, { run: fakeNpm({ viewOutput: "{\"error\":1}" }).run }), /returned/);
  assert.throws(() => updateProvider(f.dir, { run: fakeNpm({ latest: "2.0.0-rc.1" }).run }), /not a release version/);
  assert.throws(() => updateProvider(f.dir, { run: fakeNpm({ latest: "1.5.0", installFails: true }).run }), /npm install .*@\^1\.5\.0 failed: npm error ERESOLVE/);
  assert.throws(() => updateProvider(f.dir, { run: fakeNpm({ latest: "1.5.0", installs: ["^1.5.0", "1.4.22"], write: f.write }).run }), /package-lock\.json installs 1\.4\.22 .* expected 1\.5\.0/);
  f.write("^1.4.22", "1.4.22");
  assert.throws(() => updateProvider(f.dir, { run: fakeNpm({ latest: "1.5.0", installs: ["~1.5.0", "1.5.0"], write: f.write }).run }), /package\.json declares ~1\.5\.0/);
  f.write("^1.4.22", "1.4.22");
  writeFileSync(join(f.dir, "package-lock.json"), JSON.stringify({ packages: {} }));
  assert.throws(() => readState(f.dir), /does not install/);
});

test("the real manifest and lock of this package agree", () => {
  const state = readState(join(import.meta.dirname, ".."));
  assert.equal(state.range, `^${state.locked}`);
});
