# pi-cliproxyapi-bundle

Bundles the official [CLIProxyAPI provider for Pi](https://github.com/router-for-me/pi-cliproxyapi-provider) (`@router-for-me/pi-cliproxyapi-provider`, MIT, by router-for-me) into [oh-my-pi-extensions](https://github.com/zmfkzj/oh-my-pi-extensions), where it is the `cliproxyapi/` submodule. Nothing is reimplemented: this package loads the upstream package's own two entries, `extensions/index.ts` (the `cliproxyapi` provider, `/login CLIProxyAPI`, `/fast`, `/pause`, `/continue`, `/cliproxyapi-refresh`) and `extensions/tps.ts` (TUI elapsed time and TPS), in that order. See the upstream README for its setup, configuration and behavior.

```sh
pi install git:github.com/zmfkzj/pi-cliproxyapi-bundle   # on its own; the umbrella's bootstrap installs it as a submodule
```

## Version and compatibility

- This package depends on `@router-for-me/pi-cliproxyapi-provider` `^1.4.22`; its `package-lock.json` pins 1.4.22 (npm integrity recorded), so an install (on its own, or by the umbrella's bootstrap, which runs `npm install` in each submodule) is reproducible.
- Upstream declares peer `@earendil-works/pi-coding-agent >=0.82.0` and `@earendil-works/pi-ai *` (host-provided, never installed as copies) and Node ≥ 22.19. Loading and offline SSE streaming are verified with coding-agent **1.3.0**, pi-ai **1.3.0**, and provider **1.4.22**.
- Upstream's `extensions/codex-stream.ts` patches the installed Pi AI private Codex implementation at runtime. Its existing patch works with the tested 1.3.0 source; this bundle adds no replacement stream, compatibility shim, or `node_modules` edits. Future Pi/provider updates must pass the streaming tests as well as registration.

## Automatic provider updates

`.github/workflows/update-provider.yml` runs every 6 hours (and on manual dispatch) in this repository:

1. `npm ci`, then `node scripts/update-provider.ts` asks npm for the provider's `latest` version and compares it with the version `package-lock.json` installs (not the `^` range, which would hide a new minor). Same or older: nothing to do.
2. Newer: `npm install @router-for-me/pi-cliproxyapi-provider@^<latest>` updates `package.json` and `package-lock.json` together; the script fails unless both end at the new version.
3. `npm ci` of the new lock, `npm run typecheck` and `npm test` (including Pi loading and loopback SSE streaming through the real installed provider).
4. Only when all of that passed: a commit of exactly those two files to `main` by `github-actions[bot]`, pushed with the workflow's `GITHUB_TOKEN`, the same direct-to-branch policy as the umbrella's "Update submodules" workflow. Any failed step fails the run (GitHub notifies the owner) and nothing is committed; the bundle stays on the last version that passed.

The oh-my-pi-extensions umbrella's hourly "Update submodules" workflow then moves its `cliproxyapi` gitlink to that commit, and its bootstrap installs this package's lock in the `cliproxyapi/` submodule; the umbrella has no copy of the provider of its own. Requirements on GitHub: Actions enabled with read and write workflow permissions, and no branch protection on `main` that blocks `github-actions[bot]`; GitHub pauses scheduled workflows of a public repository after 60 days without activity.

This only moves the **bundled** copy. A separate install (`npm:@router-for-me/pi-cliproxyapi-provider` in your settings, which is what Pi loads instead of the bundle) is unpinned and is updated by Pi itself: `pi update --extensions` (or `pi update npm:@router-for-me/pi-cliproxyapi-provider`); a versioned `npm:@router-for-me/pi-cliproxyapi-provider@x.y.z` entry stays pinned.

## No double loading

If the same upstream package is also installed on its own, that install wins and this bundle loads nothing, so the provider, its commands and its footer exist once. "On its own" means a `packages` entry in Pi's settings that names it: `npm:@router-for-me/pi-cliproxyapi-provider[@version]`, its git repository, or a local checkout (in `~/.pi/agent/settings.json`, or in a trusted project's `.pi/settings.json`). Your existing provider setup (`cliproxyapi.json`, `/login` credentials in `auth.json`, the model cache) is the upstream package's and is used the same way by either install; this bundle never reads or writes it.

| `PI_CLIPROXYAPI_BUNDLED` | Effect |
|---|---|
| `auto` (default) | load unless installed on its own |
| `on` | always load (use only without a separate install, or the provider loads twice) |
| `off` | never load |

To switch from a separate install to the bundled one, remove `npm:@router-for-me/pi-cliproxyapi-provider` from your settings' `packages` (or run `pi remove npm:@router-for-me/pi-cliproxyapi-provider`) and `/reload`. pi-orche's `providerExtensions` is separate: workers load the provider packages listed there themselves.

## Prerequisites

A running [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and its API key: `/login CLIProxyAPI`, or `~/.pi/agent/cliproxyapi.json`, or `CLIPROXYAPI_BASE_URL` / `CLIPROXYAPI_API_KEY`. Without them the provider appears in `/login` and lists no models.

## `/cliproxyapi doctor` and `/cliproxyapi install-deps`

This bundle's own command (the upstream provider has no `/cliproxyapi`; its commands are `/cliproxyapi-refresh`, `/fast`, `/pause`, `/continue`). It is registered before the bundle decides whether to load the provider, so it is available in every mode (bundled, separate install, `PI_CLIPROXYAPI_BUNDLED=off`) without loading the provider twice. The oh-my-pi-extensions umbrella runs the same checks from `/oh-my-pi doctor` and `/oh-my-pi install-deps`.

`/cliproxyapi doctor` is read-only and reports, with an action for every problem:

- **CLIProxyAPI provider**: which install is active: the bundled copy (loaded, or failed to load: error), the separate install (ok, with the settings file that installs it), `PI_CLIPROXYAPI_BUNDLED=off` without a separate install (manual: the provider is not loaded), or `PI_CLIPROXYAPI_BUNDLED=on` together with a separate install (error: loads twice).
- **npm @router-for-me/pi-cliproxyapi-provider**: the bundled copy is installed and matches the version `package-lock.json` pins. Missing is an error while the bundled copy is the active one (an optional warning otherwise); a different version is a warning (`npm ci --legacy-peer-deps`).
- **cliproxyapi.json**: an error if it exists but is not a JSON object (the provider then ignores it).
- **CLIProxyAPI base URL**: resolved as the upstream provider does (`CLIPROXYAPI_BASE_URL` → `cliproxyapi.json` → `/login` in `auth.json` → `http://127.0.0.1:8317`, honoring `providerId`/`providerName`); shows the origin and its source.
- **CLIProxyAPI API key**: "set" with its source, or "not set" (manual: `/login CLIProxyAPI`, `CLIPROXYAPI_API_KEY` or `apiKey` in `cliproxyapi.json`). Keys are never shown.
- **CLIProxyAPI server**: one `GET {root}/v1/models?client_version=pi` with a 3 s timeout (no inference). 200 is ok; 401/403 with a key is manual (log in again); connection refused or unknown host is an error (start the server or fix the base URL); a timeout or other network failure is unverified, with a `curl` command to check by hand.

`/cliproxyapi install-deps` installs only the bundled npm dependency, with `npm install --legacy-peer-deps` in this package's directory when it is missing ("already installed" otherwise; repeatable). Inside an npm-installed package it does not run npm and asks for `pi update --extensions` instead. It then re-checks and reports the CLIProxyAPI server, the API key and `/login` as manual actions; it never starts the server or writes credentials. A separate install is updated by Pi (`pi update --extensions`), not by this command. Run `/reload` after an install. Works wherever Pi and npm run.

## Development

```sh
npm install --legacy-peer-deps
npm run typecheck
npm test
```

`test/pi-load.test.ts` loads this package with Pi's resource loader in an isolated agent directory against a local stand-in for CLIProxyAPI (catalog only, dummy key, no inference request) and checks the registered `cliproxyapi` model and commands, that a separate install in the settings turns the bundle off, and that loading the bundle together with the separately installed provider registers every command and the provider exactly once; `/cliproxyapi` stays registered (and its doctor reports the active install) with a separate install and with `PI_CLIPROXYAPI_BUNDLED=off`. `test/doctor.test.ts` covers doctor and install-deps with a temporary package directory, a local stand-in server and a fake npm. `test/update-provider.test.ts` covers the update script (no-op, update, and every failure that must stop the workflow).

`test/pi-stream.test.ts` exercises the **actual installed provider adapter**, loaded through this bundle, with a scripted loopback HTTP/SSE server and the real Pi SDK. It verifies fragmented tool arguments (including escaped strings and split UTF-8), exactly-once tool execution and tool-result replay, malformed tool JSON with zero executions, malformed SSE, pending-read cancellation, provider retry exhaustion, and SDK retry exhaustion with one final settlement. Assertions cover the normalized endpoint, plain-key authentication without a ChatGPT account header, request payload/tool schemas, optional zstd request decoding, usage/cost, and Pi's payload/response/raw-event hooks. Provider retries and SDK retries are tested separately, so intermediate attempts are not mistaken for final outcomes.

Both Pi integration suites isolate configuration in temporary directories, seed a synthetic pricing cache, and reject non-loopback fetches; allowed fetches use real HTTP, not a substituted provider stream or mocked fetch response. Run just these checks with `node --test test/pi-load.test.ts test/pi-stream.test.ts`. This is deterministic **mock-server protocol validation**, not a paid/live CLIProxyAPI or model test. Live authentication/OAuth refresh, WebSocket transport/fallback, image input, and real upstream timing remain unverified.
