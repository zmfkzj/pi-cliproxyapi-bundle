/**
 * Detect a new release of the official provider and move this package to it: `npm view` the `latest` version, compare it
 * with the version package-lock.json actually installs (a caret range alone would hide a new minor), and when it is newer
 * run `npm install <pkg>@^<latest>`, which updates package.json and package-lock.json together. The compatibility checks
 * (typecheck, tests) and the commit are the workflow's next steps (.github/workflows/update-provider.yml); this script
 * only fails loudly: a failed lookup or install, or a lock that does not end up at the new version, exits non-zero.
 *
 * Usage: node scripts/update-provider.ts [--dry-run]. Prints `updated=…`, `from=…`, `version=…` and appends them to
 * $GITHUB_OUTPUT when set.
 */
import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const PROVIDER = "@router-for-me/pi-cliproxyapi-provider";
const LOCK_KEY = `node_modules/${PROVIDER}`;

/** Release versions only (`1.4.22`); a prerelease or anything else is rejected. */
export function parseVersion(text: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(text.trim());
  if (!match) throw new Error(`not a release version: ${JSON.stringify(text)}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

export function compareVersions(a: string, b: string): number {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i]! < y[i]! ? -1 : 1;
  return 0;
}

export interface State { range: string; locked: string }

/** The provider's declared range and the version the lock installs. */
export function readState(dir: string): State {
  const manifest = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
  const lock = JSON.parse(readFileSync(join(dir, "package-lock.json"), "utf8")) as { packages?: Record<string, { version?: string }> };
  const range = manifest.dependencies?.[PROVIDER];
  const locked = lock.packages?.[LOCK_KEY]?.version;
  if (!range) throw new Error(`package.json has no dependency ${PROVIDER}`);
  if (!locked) throw new Error(`package-lock.json does not install ${PROVIDER}`);
  return { range, locked };
}

export type Plan = { update: false; from: string } | { update: true; from: string; to: string; spec: string };

/** Update only to a newer release than the locked one (never a downgrade, never a same-version reinstall). */
export function plan(state: State, latest: string): Plan {
  return compareVersions(latest, state.locked) > 0
    ? { update: true, from: state.locked, to: latest, spec: `${PROVIDER}@^${latest}` }
    : { update: false, from: state.locked };
}

export type Run = (command: string, args: string[], cwd: string) => { status: number | null; stdout: string; stderr: string };
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const defaultRun: Run = (command, args, cwd) => {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.error) return { status: null, stdout: "", stderr: result.error.message };
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
};

export function latestVersion(dir: string, run: Run = defaultRun): string {
  const result = run(npm, ["view", PROVIDER, "version", "--json"], dir);
  if (result.status !== 0) throw new Error(`npm view ${PROVIDER} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
  const version = JSON.parse(result.stdout) as unknown;
  if (typeof version !== "string") throw new Error(`npm view ${PROVIDER} returned ${result.stdout.trim()}`);
  parseVersion(version);
  return version;
}

export interface Outcome { updated: boolean; from: string; version: string }

/** Look up, plan and (unless dry) apply the update; throws on any failure. */
export function updateProvider(dir: string, options: { run?: Run; dryRun?: boolean } = {}): Outcome {
  const run = options.run ?? defaultRun;
  const before = readState(dir);
  const latest = latestVersion(dir, run);
  const next = plan(before, latest);
  if (!next.update) return { updated: false, from: next.from, version: next.from };
  if (options.dryRun) return { updated: true, from: next.from, version: next.to };
  const install = run(npm, ["install", "--save", "--legacy-peer-deps", "--ignore-scripts", "--no-audit", "--no-fund", next.spec], dir);
  if (install.status !== 0) throw new Error(`npm install ${next.spec} failed: ${install.stderr.trim() || `exit ${install.status}`}`);
  const after = readState(dir);
  if (after.locked !== next.to) throw new Error(`package-lock.json installs ${after.locked} after npm install ${next.spec}, expected ${next.to}`);
  if (after.range !== `^${next.to}`) throw new Error(`package.json declares ${after.range} after npm install ${next.spec}, expected ^${next.to}`);
  return { updated: true, from: next.from, version: next.to };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const outcome = updateProvider(resolve(fileURLToPath(import.meta.url), "../.."), { dryRun: process.argv.includes("--dry-run") });
    const lines = [`updated=${outcome.updated}`, `from=${outcome.from}`, `version=${outcome.version}`];
    console.log(lines.join("\n"));
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `${lines.join("\n")}\n`);
  } catch (error) {
    console.error(`update-provider: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  }
}
