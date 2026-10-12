# pi-cliproxyapi-bundle

Bundles the official [CLIProxyAPI provider for Pi](https://github.com/router-for-me/pi-cliproxyapi-provider) (`@router-for-me/pi-cliproxyapi-provider`, MIT, by router-for-me) into [oh-my-pi-extensions](https://github.com/zmfkzj/oh-my-pi-extensions), where it is the `cliproxyapi/` submodule. Nothing is reimplemented: this package loads the upstream package's own two entries, `extensions/index.ts` (the `cliproxyapi` provider, `/login CLIProxyAPI`, `/fast`, `/pause`, `/continue`, `/cliproxyapi-refresh`) and `extensions/tps.ts` (TUI elapsed time and TPS), in that order. See the upstream README for its setup, configuration and behavior.

```sh
pi install git:github.com/zmfkzj/pi-cliproxyapi-bundle   # on its own; the umbrella's bootstrap installs it as a submodule
```

## Version and compatibility

- This package depends on `@router-for-me/pi-cliproxyapi-provider` `^1.4.22`; its `package-lock.json` pins 1.4.22 (npm integrity recorded), so an install (on its own, or by the umbrella's bootstrap, which runs `npm install` in each submodule) is reproducible.
- Upstream declares peer `@earendil-works/pi-coding-agent >=0.82.0` and `@earendil-works/pi-ai *` (host-provided, never installed as copies) and Node ≥ 22.19. Verified loading with Pi 1.1.0.

## Automatic provider updates

`.github/workflows/update-provider.yml` runs every 6 hours (and on manual dispatch) in this repository:

1. `npm ci`, then `node scripts/update-provider.ts` asks npm for the provider's `latest` version and compares it with the version `package-lock.json` installs (not the `^` range, which would hide a new minor). Same or older: nothing to do.
2. Newer: `npm install @router-for-me/pi-cliproxyapi-provider@^<latest>` updates `package.json` and `package-lock.json` together; the script fails unless both end at the new version.
3. `npm ci` of the new lock, `npm run typecheck` and `npm test` (including the Pi loader test with the real provider).
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

## Development

```sh
npm install --legacy-peer-deps
npm run typecheck
npm test
```

`test/pi-load.test.ts` loads this package with Pi's resource loader in an isolated agent directory against a local stand-in for CLIProxyAPI (catalog only, dummy key, no inference request) and checks the registered `cliproxyapi` model and commands, that a separate install in the settings turns the bundle off, and that loading the bundle together with the separately installed provider registers every command and the provider exactly once. `test/update-provider.test.ts` covers the update script (no-op, update, and every failure that must stop the workflow).
