// When the bundle loads the upstream provider, and when it leaves it to a separate install (no double loading).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { bundleMode, createCliproxyapiBundle, decideBundle, isUpstreamSource, PACKAGE_NAME, separateInstalls } from "../src/index.ts";

function setup(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "pi cliproxyapi bundle "));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const agentDir = join(dir, "agent");
  const cwd = join(dir, "project");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  const settings = (file: string, packages: unknown[]) => writeFileSync(file, JSON.stringify({ packages }));
  return { dir, agentDir, cwd, settings, global: join(agentDir, "settings.json"), project: join(cwd, ".pi", "settings.json") };
}

test("package sources that name the upstream package", (t) => {
  const s = setup(t);
  for (const source of [`npm:${PACKAGE_NAME}`, `npm:${PACKAGE_NAME}@1.4.22`, "git:github.com/router-for-me/pi-cliproxyapi-provider", "https://github.com/router-for-me/pi-cliproxyapi-provider.git", "git:github.com/router-for-me/pi-cliproxyapi-provider@v1.4.22"]) {
    assert.equal(isUpstreamSource(source, s.dir), true, source);
  }
  for (const source of ["npm:@router-for-me/pi-cliproxyapi-provider-fork", "npm:pi-cliproxyapi-provider", "https://github.com/zmfkzj/oh-my-pi-extensions.git", "./missing"]) {
    assert.equal(isUpstreamSource(source, s.dir), false, source);
  }
  mkdirSync(join(s.dir, "checkout"));
  writeFileSync(join(s.dir, "checkout", "package.json"), JSON.stringify({ name: PACKAGE_NAME }));
  assert.equal(isUpstreamSource("./checkout", s.dir), true, "a local checkout, relative to the settings directory");
});

test("a separate install in the user's settings (string or filtered object entry) wins; a project one only when trusted", (t) => {
  const s = setup(t);
  assert.deepEqual(separateInstalls({ agentDir: s.agentDir, cwd: s.cwd, projectTrusted: true }), []);
  s.settings(s.global, ["https://github.com/zmfkzj/oh-my-pi-extensions.git", `npm:${PACKAGE_NAME}`]);
  assert.deepEqual(separateInstalls({ agentDir: s.agentDir, cwd: s.cwd }), [s.global]);
  s.settings(s.global, [{ source: `npm:${PACKAGE_NAME}`, extensions: ["extensions/index.ts"] }]);
  assert.deepEqual(separateInstalls({ agentDir: s.agentDir, cwd: s.cwd }), [s.global]);
  s.settings(s.global, []);
  s.settings(s.project, [`npm:${PACKAGE_NAME}`]);
  assert.deepEqual(separateInstalls({ agentDir: s.agentDir, cwd: s.cwd, projectTrusted: false }), []);
  assert.deepEqual(separateInstalls({ agentDir: s.agentDir, cwd: s.cwd, projectTrusted: true }), [s.project]);
  writeFileSync(s.global, "{ broken");
  assert.deepEqual(separateInstalls({ agentDir: s.agentDir, cwd: s.cwd, projectTrusted: false }), [], "an unreadable settings file is no install");
});

test("PI_CLIPROXYAPI_BUNDLED forces on or off; auto follows the settings", (t) => {
  const s = setup(t);
  assert.equal(bundleMode(undefined), "auto");
  assert.equal(bundleMode(" OFF "), "off");
  assert.equal(bundleMode("maybe"), "auto");
  const base = { agentDir: s.agentDir, cwd: s.cwd, projectTrusted: false };
  assert.deepEqual(decideBundle({ ...base, env: {} }), { load: true, reason: "bundled" });
  s.settings(s.global, [`npm:${PACKAGE_NAME}`]);
  const separate = decideBundle({ ...base, env: {} });
  assert.equal(separate.load, false);
  assert.match(separate.reason, /installed on its own .*settings\.json/);
  assert.equal(decideBundle({ ...base, env: { PI_CLIPROXYAPI_BUNDLED: "on" } }).load, true);
  s.settings(s.global, []);
  assert.equal(decideBundle({ ...base, env: { PI_CLIPROXYAPI_BUNDLED: "off" } }).load, false);
});

/** The parts of ExtensionAPI the bundle itself uses (the upstream factories are replaced). */
function fakePi() {
  const commands: string[] = [];
  const channels: string[] = [];
  const pi = { registerCommand: (name: string) => { commands.push(name); }, events: { on: (channel: string) => { channels.push(channel); return () => {}; } } };
  return { pi: pi as never, commands, channels };
}

test("the bundle runs the upstream entries in order, or none of them; /cliproxyapi is registered either way", async (t) => {
  const s = setup(t);
  const calls: string[] = [];
  const load = async () => [async () => { calls.push("index"); }, () => { calls.push("tps"); }];
  const base = { agentDir: s.agentDir, cwd: s.cwd, projectTrusted: false, env: {}, load };
  const bundled = fakePi();
  await createCliproxyapiBundle(base)(bundled.pi);
  assert.deepEqual(calls, ["index", "tps"]);
  assert.deepEqual(bundled.commands, ["cliproxyapi"]);
  assert.deepEqual(bundled.channels, ["oh-my-pi-extensions:dependencies"]);
  s.settings(s.global, [`npm:${PACKAGE_NAME}`]);
  const separate = fakePi();
  await createCliproxyapiBundle(base)(separate.pi);
  assert.deepEqual(calls, ["index", "tps"], "nothing more when installed on its own");
  assert.deepEqual(separate.commands, ["cliproxyapi"], "the maintenance command stays available");
  s.settings(s.global, []);
  const off = fakePi();
  await createCliproxyapiBundle({ ...base, env: { PI_CLIPROXYAPI_BUNDLED: "off" } })(off.pi);
  assert.deepEqual(calls, ["index", "tps"], "nothing more when off");
  assert.deepEqual(off.commands, ["cliproxyapi"]);
  assert.deepEqual(off.channels, ["oh-my-pi-extensions:dependencies"]);
});
