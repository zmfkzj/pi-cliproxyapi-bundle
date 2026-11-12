# pi-cliproxyapi-bundle

Bundles the [CLIProxyAPI provider for Pi by 0xRichardH](https://github.com/0xRichardH/pi-cliproxyapi-provider) (npm `pi-cliproxyapi-provider`, MIT) into [oh-my-pi-extensions](https://github.com/zmfkzj/oh-my-pi-extensions), where it is the `cliproxyapi/` submodule. Nothing is reimplemented: this package loads the upstream package's single extension entry, `extensions/index.ts`: the CLIProxyAPI provider (default id `cpa`, models discovered from `/v1/models` and enriched with models.dev metadata; Codex GPT models on the Responses API, Claude models on Anthropic Messages, others on Chat Completions) and its `/cliproxyapi config|status|refresh|aliases|models` command. See the upstream README for its setup, configuration and behavior.

It replaces the former provider, [router-for-me/pi-cliproxyapi-provider](https://github.com/router-for-me/pi-cliproxyapi-provider) (`@router-for-me/pi-cliproxyapi-provider`, bundled up to 1.4.25). The two packages share only the purpose; see [Migrating from the former provider](#migrating-from-the-former-provider).

```sh
pi install git:github.com/zmfkzj/pi-cliproxyapi-bundle   # on its own; the umbrella's bootstrap installs it as a submodule
```

## Version and compatibility

- This package depends on `pi-cliproxyapi-provider` `^0.16.10`; its `package-lock.json` pins 0.16.10 (npm integrity recorded), so an install (on its own, or by the umbrella's bootstrap, which runs `npm install` in each submodule) is reproducible. The npm 0.16.10 tarball is byte-identical to the upstream tag `v0.16.10` (commit `b40826f`, npm `gitHead` the same).
- Upstream declares optional peers `@earendil-works/pi-ai`, `pi-coding-agent` and `pi-tui` `>=0.87.0` (host-provided, never installed as copies) and has no runtime dependencies. Loading, model discovery and offline SSE streaming are verified with coding-agent **1.5.0**, pi-ai **1.5.0**, and provider **0.16.10**.
- Upstream patches no Pi internals and keeps no shared patched-module cache, so this bundle no longer has the former provider's Codex module-cache protection (`src/codex-cache.ts` was removed with it).

## Migrating from the former provider

The replacement reads none of the former provider's settings. Nothing is migrated automatically; this bundle never writes Pi's settings or credentials.

| | former (`@router-for-me/…` 1.4.x) | now (`pi-cliproxyapi-provider` 0.16.x) |
|---|---|---|
| Provider id / model ids | `cliproxyapi` → `cliproxyapi/<model>` | `cpa` → `cpa/<model>` (set `providerName` to change it) |
| Connection config | `~/.pi/agent/cliproxyapi.json` (`baseUrl` origin, `providerId`, `apiKey`, `fast`) | `~/.pi/agent/pi-cliproxyapi-provider/config.json` under the home directory (`providerName`, `baseUrl` ending in `/v1`, `apiKey`, …), written by `/cliproxyapi config` |
| Environment | `CLIPROXYAPI_BASE_URL`, `CLIPROXYAPI_API_KEY`, `CLIPROXYAPI_PROVIDER_ID`, `CLIPROXYAPI_FAST`, `CLIPROXYAPI_TRANSPORT`, … | `CLIPROXYAPI_BASE_URL`, `CLIPROXYAPI_API_KEY`, `CLIPROXYAPI_PROVIDER_NAME`, `CLIPROXYAPI_AUTH_REQUIRED`, `CLIPROXYAPI_AUTH_HEADER`, `CLIPROXYAPI_MODELS_DEV_ENABLED`, `CLIPROXYAPI_METADATA_FALLBACK_PROVIDER` |
| Login | `/login CLIProxyAPI` (stored as an OAuth-type entry) | `/login <provider id>` with an API key |
| Commands | `/cliproxyapi-refresh`, `/fast`, `/pause`, `/continue`, TPS footer | `/cliproxyapi …`; a TPS notice after each turn when the gateway sends a TPS header |
| Codex transport | its own `cliproxyapi-codex-responses` API on `/backend-api/codex/responses` (SSE or WebSocket) | Pi's `openai-responses` on `<baseUrl>/responses`, with function tools sent as `strict: null` |

To keep existing `cliproxyapi/<model>` selections (Pi's `defaultProvider`/`defaultModel`, pi-orche `models`/`routes`, scoped models): create `~/.pi/agent/pi-cliproxyapi-provider/config.json` with `{"providerName": "cliproxyapi", "baseUrl": "http://127.0.0.1:8317/v1"}` (your CLIProxyAPI address plus `/v1`), or run `/cliproxyapi config connection`; then `/login cliproxyapi` with the API key and `/reload`. An OAuth-type `cliproxyapi` entry left in `auth.json` by the former `/login` is not usable: the provider then discovers no models (it registers a `login-required` placeholder) until `/login cliproxyapi` replaces it with an API key. Otherwise switch the selections to `cpa/<model>`. `/cliproxyapi-bundle doctor` reports both situations with these steps.

Other places that name the former package keep loading it, for example pi-orche `providerExtensions: ["npm:@router-for-me/pi-cliproxyapi-provider"]` or a separate `npm:@router-for-me/pi-cliproxyapi-provider` install; replace them with `npm:pi-cliproxyapi-provider` (or remove the separate install).

## Automatic provider updates

`.github/workflows/update-provider.yml` runs every 6 hours (and on manual dispatch) in this repository:

1. `npm ci`, then `node scripts/update-provider.ts` asks npm for the provider's `latest` version and compares it with the version `package-lock.json` installs (not the `^` range, which would hide a new minor). Same or older: nothing to do.
2. Newer: `npm install pi-cliproxyapi-provider@^<latest>` updates `package.json` and `package-lock.json` together; the script fails unless both end at the new version.
3. `npm ci` of the new lock, `npm run typecheck` and `npm test` (including Pi loading and loopback SSE streaming through the real installed provider).
4. Only when all of that passed: a commit of exactly those two files to `main` by `github-actions[bot]`, pushed with the workflow's `GITHUB_TOKEN`, the same direct-to-branch policy as the umbrella's "Update submodules" workflow. Any failed step fails the run (GitHub notifies the owner) and nothing is committed; the bundle stays on the last version that passed.

Upstream publishes a patch release whenever its bundled models.dev catalog changes (daily at most), so this workflow can commit that often. The oh-my-pi-extensions umbrella's hourly "Update submodules" workflow then moves its `cliproxyapi` gitlink to that commit, and its bootstrap installs this package's lock in the `cliproxyapi/` submodule; the umbrella has no copy of the provider of its own. Requirements on GitHub: Actions enabled with read and write workflow permissions, and no branch protection on `main` that blocks `github-actions[bot]`; GitHub pauses scheduled workflows of a public repository after 60 days without activity.

This only moves the **bundled** copy. A separate install (`npm:pi-cliproxyapi-provider` in your settings, which is what Pi loads instead of the bundle) is unpinned and is updated by Pi itself: `pi update --extensions` (or `pi update npm:pi-cliproxyapi-provider`); a versioned `npm:pi-cliproxyapi-provider@x.y.z` entry stays pinned.

## No double loading

If the same upstream package is also installed on its own, that install wins and this bundle loads nothing, so the provider and its command exist once. "On its own" means a `packages` entry in Pi's settings that names it: `npm:pi-cliproxyapi-provider[@version]`, its git repository (`github.com/0xRichardH/pi-cliproxyapi-provider`), or a local checkout whose `package.json` is named `pi-cliproxyapi-provider` (in `~/.pi/agent/settings.json`, or in a trusted project's `.pi/settings.json`). Your provider setup (`pi-cliproxyapi-provider/config.json`, the `/login` credential in `auth.json`, the snapshots in `~/.cache/pi-cliproxyapi-provider/`) is the upstream package's and is used the same way by either install; this bundle never writes it.

An install of the **former** package (`@router-for-me/pi-cliproxyapi-provider`) is a different package: it does not turn this bundle off, and both providers load side by side (`cliproxyapi/…` from the former, `cpa/…` or your `providerName` from this one; both use the name `cliproxyapi` only if you configure that, which then conflicts). Remove the former install when you use this bundle.

| `PI_CLIPROXYAPI_BUNDLED` | Effect |
|---|---|
| `auto` (default) | load unless installed on its own |
| `on` | always load (use only without a separate install, or the provider loads twice) |
| `off` | never load |

To switch from a separate install to the bundled one, remove `npm:pi-cliproxyapi-provider` from your settings' `packages` (or run `pi remove npm:pi-cliproxyapi-provider`) and `/reload`. pi-orche's `providerExtensions` is separate: workers load the provider packages listed there themselves.

## Prerequisites

A running [CLIProxyAPI](https://github.com/router-for-me/CLIProxyAPI) and its API key: `/login cpa` (or `/login <providerName>`), `apiKey` in `~/.pi/agent/pi-cliproxyapi-provider/config.json` (a literal or an allowed `!command`), or `CLIPROXYAPI_API_KEY`; base URL by `/cliproxyapi config connection` or `CLIPROXYAPI_BASE_URL` (default `http://localhost:8317/v1`). Without a key the provider registers a `login-required` placeholder model and no discovered models.

## `/cliproxyapi-bundle doctor` and `/cliproxyapi-bundle install-deps`

This bundle's own command. It is not `/cliproxyapi`: the provider registers that name itself (`config`, `status`, `refresh`, `aliases`, `models`), and two extensions with one command name would both be renamed (`/cliproxyapi:1`, `/cliproxyapi:2`). It is registered before the bundle decides whether to load the provider, so it is available in every mode (bundled, separate install, `PI_CLIPROXYAPI_BUNDLED=off`) without loading the provider twice. The oh-my-pi-extensions umbrella runs the same checks from `/oh-my-pi doctor` and `/oh-my-pi install-deps` (package id `cliproxyapi`).

`/cliproxyapi-bundle doctor` is read-only and reports, with an action for every problem:

- **CLIProxyAPI provider**: which install is active: the bundled copy (loaded, or failed to load: error), the separate install (ok, with the settings file that installs it), `PI_CLIPROXYAPI_BUNDLED=off` without a separate install (manual: the provider is not loaded), or `PI_CLIPROXYAPI_BUNDLED=on` together with a separate install (error: loads twice).
- **npm pi-cliproxyapi-provider**: the bundled copy is installed and matches the version `package-lock.json` pins. Missing is an error while the bundled copy is the active one (an optional warning otherwise); a different version is a warning (`npm ci --legacy-peer-deps`).
- **CLIProxyAPI config**: an error if `~/.pi/agent/pi-cliproxyapi-provider/config.json` exists but is not a JSON object. The provider's own field validation (for example the `apiKey` command allowlist) is reported by the provider when it loads.
- **former provider config** (optional warning): `~/.pi/agent/cliproxyapi.json` exists and the new config does not; the action is the config to create for the former provider id and base URL.
- **CLIProxyAPI provider name**: the provider id (`CLIPROXYAPI_PROVIDER_NAME` → config `providerName` → `cpa`) under which models are registered.
- **CLIProxyAPI base URL**: resolved as the provider does (`CLIPROXYAPI_BASE_URL` → config `baseUrl` → `http://localhost:8317/v1`); shows the origin and its source.
- **CLIProxyAPI login** (manual): `auth.json` holds an OAuth-type entry for that provider id (the former provider's `/login`), which the provider cannot use.
- **CLIProxyAPI API key**: "set" with its source (a stored `/login` API key, then config `apiKey`, then `CLIPROXYAPI_API_KEY`, Pi's order), "not required" with `authRequired` false, or "not set" (manual). Keys are never shown and an `apiKey` `!command` is never run.
- **CLIProxyAPI server**: one `GET <baseUrl>/models` with a 3 s timeout (no inference), with the key when it is a literal. 200 is ok; 401/403 with a key is manual (log in again); connection refused or unknown host is an error (start the server or fix the base URL); a timeout or other network failure is unverified, with a `curl` command to check by hand.

`/cliproxyapi-bundle install-deps` installs only the bundled npm dependency, with `npm install --legacy-peer-deps` in this package's directory when it is missing ("already installed" otherwise; repeatable). Inside an npm-installed package it does not run npm and asks for `pi update --extensions` instead. It then re-checks and reports the CLIProxyAPI server, the API key and `/login` as manual actions; it never starts the server or writes credentials. A separate install is updated by Pi (`pi update --extensions`), not by this command. Run `/reload` after an install. Works wherever Pi and npm run.

## Development

```sh
npm install --legacy-peer-deps
npm run typecheck
npm test
```

`test/pi-load.test.ts` loads this package with Pi's resource loader in an isolated home and agent directory against a local stand-in for CLIProxyAPI (model list only, dummy key, no inference request) and checks the discovered `cpa` models and their API routing (Responses, Anthropic Messages with the `/v1` stripped, Chat Completions), that `providerName` in the provider's config keeps `cliproxyapi/<model>` ids, the provider's `/cliproxyapi` and this bundle's `/cliproxyapi-bundle` (each once, unsuffixed), that a separate install in the settings turns the bundle off, and that loading the bundle together with the separately installed provider registers the provider and every command exactly once; `/cliproxyapi-bundle` stays registered (and its doctor reports the active install) with a separate install and with `PI_CLIPROXYAPI_BUNDLED=off`. `test/doctor.test.ts` covers doctor and install-deps with a temporary package and home directory, a local stand-in server and a fake npm, including the configuration precedence and the migration hints. `test/update-provider.test.ts` covers the update script (no-op, update, and every failure that must stop the workflow).

`test/pi-stream.test.ts` exercises the **actual installed provider**, loaded through this bundle, with a scripted loopback HTTP/SSE server and the real Pi SDK. For a Codex GPT model (Pi's `openai-responses` driver) it verifies fragmented tool arguments (including escaped strings and split UTF-8), exactly-once tool execution and tool-result replay, malformed tool JSON with zero executions, pending-read cancellation, SDK abort, and a failed response, each with one final settlement; assertions cover the `<baseUrl>/responses` endpoint, Bearer authentication without a ChatGPT account header, the provider's `strict: null` function tools on agent turns (its `before_provider_request` adapter; a direct `streamSimple` call does not run extension hooks), and usage. For a Claude model it verifies `/v1/messages` on the proxy origin, Bearer authentication and streamed text.

Both Pi integration suites isolate configuration in temporary directories (HOME included: the provider keeps its config and snapshots under the home directory) and reject non-loopback fetches; allowed fetches use real HTTP, not a substituted provider stream or mocked fetch response. Run just these checks with `node --test test/pi-load.test.ts test/pi-stream.test.ts`. This is deterministic **mock-server protocol validation**, not a paid/live CLIProxyAPI or model test. Live authentication, real CLIProxyAPI responses and upstream timing, models.dev refresh, image input, and the interactive `/cliproxyapi config|models` panels remain unverified. The former suite's Codex-specific checks (its own Codex SSE parser and retry loop, WebSocket transport, and the patched-module cache under concurrent Pi processes) no longer apply and were removed with that code.
