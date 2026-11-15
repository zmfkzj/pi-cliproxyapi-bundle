# Source overlay of pi-cliproxyapi-provider

The bundle ships fixes to files of [pi-cliproxyapi-provider](https://github.com/0xRichardH/pi-cliproxyapi-provider) (MIT, Copyright (c) 2026 Richard Hao) here, until upstream has them. The installed npm package is not edited. When the bundle loads the provider (`src/index.ts` `loadUpstream`), `src/overlay.ts` takes these steps:

1. It checks that each file listed in `manifest.json` still has its `upstreamSha256` in the installed package.
2. It copies the installed package once to `<bundle>/.provider-overlay/<version>-<hash>/`. That directory is generated and ignored by git. Copies of other versions are removed when they are a day old.
3. It replaces the listed files with the copies under `pi-cliproxyapi-provider/`.
4. It loads the provider's `extensions/index.ts` from that copy.

If a listed upstream file has changed, the overlay is skipped and the unmodified package loads. The same happens when the copy cannot be written. `/cliproxyapi-bundle doctor` then reports `provider source overlay` as a warning with the reason.

A separate install of the provider (`npm:pi-cliproxyapi-provider` in Pi's settings, see "No double loading" in the bundle README) loads instead of the bundle and never uses this overlay.

## Current fix: routing-prefixed model IDs (`src/matching.ts`, written for 0.16.13)

CLIProxyAPI can expose a model under a credential prefix, for example `bts/claude-opus-5-5`. The full ID matched nothing in models.dev metadata. Upstream 0.16.13 then registered it with the defaults: `reasoning: false`, no thinking levels, a 128k context window and zero cost. Pi clamped every thinking level of such a model to `off`.

The overlay's `findMetadataMatch` handles this in three steps:

1. **Full ID first.** It runs the upstream rules on the full ID, unchanged and in the same order: alias, exact key, unique metadata ID, canonical owner, owner hint, unique suffix and normalized suffix, then the fallback provider.
2. **Remainder only on no match.** Only if nothing matches does it drop the leftmost `segment/` and apply the same rules to the rest. It repeats this one segment at a time. So `bts/anthropic/claude-opus-5-5` meets the key `anthropic/claude-opus-5-5` before the bare name is tried.
3. **No guessing.** The upstream uniqueness checks still apply, so an ambiguous remainder stays unmatched.

The model keeps its full ID in three places:

- the registered model;
- `modelOverrides` keys;
- the request to the proxy, which routes by the prefix.

An alias of the full ID still wins over everything. An alias of the bare name (for example `claude-opus-4-6-thinking`) also applies to its prefixed IDs when the full ID matches nothing.

## Updating

The automatic provider update (`.github/workflows/update-provider.yml`) runs the bundle's tests. `test/overlay.test.ts` fails when the newly installed provider changed a file the overlay replaces. In that case the update is not committed. To move to such a version:

1. Run `npm install pi-cliproxyapi-provider@<version>`, then compare the new upstream file with the overlay copy.
2. If upstream now resolves routing-prefixed IDs itself, remove the file from `manifest.json` and from `pi-cliproxyapi-provider/`. If no file remains, remove the overlay.
3. Otherwise, copy the new upstream file and re-apply the marked overlay change. Record the new file's sha256 as `upstreamSha256`, and the version as `writtenFor`.
4. Run `npm run typecheck` and `npm test`.
