# WASDEngine fork maintenance

WASDEngine ([WASDEngine/WASDEngine](https://github.com/WASDEngine/WASDEngine)) is a fork of DeepSeek Harness ([deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)). Every WASDEngine service and agent behavior is configuration: four patch files appended to the `@deepseek-ai/dsh-base`, `@deepseek-ai/dsh-sdk-minimal`, and `@deepseek-ai/dsh-web-app` bundles, which together reach every shipped profile, three bundled skills, a drift spec, and documentation. The Desktop app and the harness home carry their own WASDEngine identity through one brand module, one-line hooks in upstream Desktop files, and a second drift spec; the Web UI, which the Desktop app also renders, carries it through a fork-owned brand-mark occupant in `ui-brand-official`, replaced Web icons and install names, and two more drift specs. Upstream's GitHub Actions workflows, Dependabot configuration, and the specs that read them are deleted. This file lists each fork change, how to merge upstream releases, and what to re-check after a merge. The public front page is [.github/README.md](../.github/README.md).

## Branches and remotes

| Ref | Role |
|---|---|
| `main` on `origin` (WASDEngine/WASDEngine) | The fork's default branch; every fork change lands here. |
| `upstream/master` (deepseek-ai/deepseek-harness) | The upstream development branch. Pushing to `upstream` is disabled. |
| `dsh-v<version>` tags | Upstream release tags, fetched with `git fetch upstream --tags`. |

`main` started from upstream `master` at the merge of release 0.2.2-rc.1; `git merge-base main upstream/master` prints the commit the fork last merged. A fresh clone adds the upstream remote with:

```sh
git remote add upstream https://github.com/deepseek-ai/deepseek-harness.git
git remote set-url --push upstream DISABLED-do-not-push-to-upstream
```

## Merge upstream

Run `wasdengine/sync-upstream.sh` from any directory of the fork, or `UPSTREAM_REF=dsh-v<version> wasdengine/sync-upstream.sh` for a release tag. The script fast-forwards `main` from `origin`, merges the upstream ref with `--no-ff --no-commit`, deletes every tracked file that an entry of [upstream-prune.txt](upstream-prune.txt) names or contains (files named `.github/workflows/wasd-*` and `.github/actions/wasd-*` stay), and commits when no other conflict remains. Deleting a pruned path also resolves the conflict that an upstream edit to it causes. The script stops on any other conflict, prints the commit command with the checkout's directory, and never pushes. It refuses to start on a detached HEAD that neither `origin/main` nor `main` contains, because switching to `main` would leave that commit behind. It also stops before pruning or committing when `git merge` does not start, for example because an untracked file would be overwritten.

The same merge with plain Git:

```sh
git checkout main
git pull --ff-only origin main
git fetch upstream master
git merge --no-ff --no-commit upstream/master
grep -v -e '^#' -e '^$' wasdengine/upstream-prune.txt | sed 's/^/:(literal)/' \
  | xargs git ls-files --cached -- | sort -u \
  | grep -v -e '^\.github/workflows/wasd-' -e '^\.github/actions/wasd-' \
  | while IFS= read -r path; do git rm -q -f -- ":(literal)$path"; done
# Resolve conflicts with the tables below, run the merge checklist, then:
git commit
git push origin main
```

## Upstream files the fork modifies

| File | Fork change | Diff | When it conflicts |
|---|---|---|---|
| `packages/bundle/base/package.json`, `packages/bundle/sdk-minimal/package.json` | `dsh.bundle.patch` becomes a list that appends `./wasdengine/gateway.cordis.patch.yml` after `./cordis.patch.yml`, and `files` lists the fork file. | +5 −1 each | Take upstream's side, then turn `dsh.bundle.patch` into the list again with the fork file last. Put the fork file in `files` in the order that `pnpm run constraints` prints in its error. |
| `packages/bundle/base/tests/base.spec.ts`, `packages/bundle/sdk-minimal/tests/sdk-minimal.spec.ts` | The manifest test reads the first `dsh.bundle.patch` entry, because the fork's file follows it. | +3 −3 each | Take upstream's side and read `patch[0]` where the test reads `dsh.bundle.patch` again. |
| `packages/bundle/web-app/package.json` | Appends `./wasdengine/telemetry.cordis.patch.yml` and `./wasdengine/gamedev.cordis.patch.yml` to the end of `dsh.bundle.patch`, and lists both files plus `wasdengine/skills` in `files`. | +6 −1 | Take upstream's side, then re-append the two fork patch files as the last `dsh.bundle.patch` entries. Put the same files in `files` in the order that `pnpm run constraints` prints in its error. |
| `scripts/check-workspace-constraints.ts` | Adds `wasdengine/skills` to the `packageFileExtras` entry of `@deepseek-ai/dsh-web-app`, so the package may publish the skill directory. | +1 −1 | Take upstream's side and add `'wasdengine/skills'` to that entry again. |
| `scripts/product-package-policy.ts` | Classifies `packages/host/product-telemetry-otel`, `packages/session/session-telemetry-otel`, and its Service Definition `packages/session/session-telemetry` as `optional`, because the overlay disables every row that mounts the two exporters and `verify-product-use` rejects a package without product use. | +3 | Take upstream's side and add the entries again. When the gate reports an entry as stale, upstream mounts the package elsewhere: check that row for DeepSeek uploads, then remove the entry. |
| Paths in `wasdengine/upstream-prune.txt`: `.github/workflows/`, `.github/actions/`, `.github/dependabot.yml`, and 13 specs that read workflow files | Deleted. | 32 workflows, Dependabot, 13 specs | The sync script deletes them again, which resolves the modify/delete conflict. When a new upstream spec fails with `ENOENT` on a `.github/workflows/` file, add its path to `upstream-prune.txt`. Each entry is a literal path or directory: the sync script passes it as a `:(literal)` pathspec and `verify-md-links` compares it as a path, so neither expands a wildcard. |
| `scripts/verify-md-links.ts` | `isPrunedUpstreamPath` reads `wasdengine/upstream-prune.txt`, and a link whose missing target is a listed literal path or lies under one is not reported, because upstream documents and Agent Notes still link to the deleted workflows and specs. | +21 −1 | Take upstream's side, then restore the `sep` import, the `isPrunedUpstreamPath` function, and its call in the missing-target branch of `findViolations`. |
| `packages/client/ui-settings-account/src/client/onboarding-balance.ts` | `hasOnboardingCredit` treats a Platform that reports no wallets as funded, so Desktop onboarding does not ask WASDEngine accounts to add credits. | +5 −2 | Take upstream's side and restore the empty-wallet rule; `tests/wasdengine-onboarding-balance.client.spec.ts` fails until it is back. |
| `packages/client/ui-brand-official/src/client/index.ts` | `apply` calls `applyWasdengineBrand` in place of the `official`-profile registration of the DeepSeek Harness sidebar mark and wordmark; the home frame layer stays. | +4 −9 | Take upstream's side, then replace its brand-slot registrations with the `applyWasdengineBrand(ctx)` call and its import again. Route a new upstream brand occupant through `wasdengine-brand.tsx` or leave it out. |
| `packages/client/ui-brand-official/tests/browser-plugin.client.spec.tsx` | Expects both brand marks and the frame layer in every build profile, and the brand name on its fallback. | +8 −17 | Take upstream's side and re-apply the expectations. |
| `packages/client/ui-brand-official/src/client/assets/breach-atlas.webp` | The home click animation draws the WASD keycaps instead of the whale breach; `apps/desktop/scripts/wasdengine-render-icons.ts` renders it. | binary | Keep the fork's file (`git checkout --ours`). When upstream changes `ATLAS` in `src/client/home-whale/renderer.ts`, copy it into `WASDENGINE_HOME_ATLAS` and rerender; the Desktop drift spec fails until they match. |
| `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts` | Generated; names `WasdengineMark` as the occupant of `sidebar.brand.mark` and `conversation.hero.brand.mark`. | +5 −4 | Take upstream's side and run `pnpm run gen-client-catalog`. |
| `apps/web/public/favicon.svg`, `favicon-dark.svg` | The WASD keycap mark in fixed black and white ink. | +16 −2 each | Keep the fork's files; the `ui-brand-official` drift spec fails unless they draw the keycaps and letters of the in-app mark. |
| `apps/web/public/icon-192.png`, `icon-512.png`, `icon-maskable-512.png`, `apple-touch-icon.png` | Rendered from `apps/desktop/wasdengine/icon-windows.svg` by `apps/web/scripts/wasdengine-app-icons.ts`. | binary | Keep the fork's files and rerun the fork script; upstream's `render:app-icons` script writes the whale icons. |
| `apps/web/public/manifest.webmanifest`, `apps/web/index.html` | `name`, `short_name`, and `apple-mobile-web-app-title` are WASDEngine. | +2 −2, +1 −1 | Take upstream's side and set the three names again. |
| `apps/web/tests/pwa-manifest.e2e.ts` | Compares the shipped icons with the fork renderer's tile, imported under the upstream names, counts the light keycaps as ink, and expects the WASDEngine names. | +9 −5 | Take upstream's side and re-apply the import, the ink comparison, and the names. |
| `apps/web/tests/built-boot.expected.e2e.ts` | Expects the WASD mark and the local-build name in every build profile. | +10 −14 | Take upstream's side and re-apply. |
| `packages/util/home-paths/src/index.ts` | `DSH_HOME_DIR_NAME` is `.wasdengine`, so `dsh web`, the CLI, and the Desktop app default to `~/.wasdengine`; `DSH_HOME` still overrides it. Three JSDoc lines name the new default. | +4 −4 | Take upstream's side, then set the constant and the JSDoc mentions of `~/.dsh` in that file again. |
| `apps/desktop/electron-builder.config.mjs` | The default export is a function that returns `applyWasdengineBrand(createElectronBuilderConfig())`; electron-builder calls it when it loads the configuration, and the named factory export stays upstream's. | +3 −1 | Take upstream's side and wrap its default export again. |
| `apps/desktop/electron-builder.config.d.mts` | Declares that default export as a function returning `WasdengineElectronBuilderConfig`. | +3 −1 | Take upstream's side and restore the import and the declaration. |
| `apps/desktop/tsconfig.client.json` | Lists `src/wasdengine-brand.ts`, which `src/locale.ts` imports into the client program. | +1 | Add the entry again. |
| `apps/desktop/src/locale.ts` | Imports `brandDesktopDictionaries` and passes the dictionary map through it. | +3 −1 | Re-apply the import and the `const dictionaries` line. New messages need no edit. |
| `apps/desktop/src/main.ts` | The macOS About panel title and the deep-link registration and `open-url` check read `WASDENGINE_DESKTOP_BRAND`. | +4 −3 | Re-apply the import and the three lines; port any new `dsh://` literal to the brand scheme. |
| `apps/desktop/scripts/desktop-package-environment.mjs` | Unsigned local builds use `WASDENGINE_DESKTOP_BRAND.appId` instead of `com.deepseek.harness`. | +2 −1 | Re-apply the import and the `DSH_DESKTOP_APP_ID` line. |
| `apps/desktop/scripts/development-app.ts` | The macOS development bundle registers the `wasdengine` scheme under `com.wasdengine.desktop.dev.<hash>`. | +3 −2 | Re-apply the import and the two plist values. |
| `apps/desktop/scripts/smoke-packaged-runtime.ts`, `package-target.ts`, `package-macos.ts`, `verify-retained-desktop.ts` | The packaged bundle and executable paths use the brand product name. | +3 −2, +3 −2, +2 −1, +2 −1 | Take upstream's side and replace every `DeepSeek Harness.app`, `DeepSeek Harness.exe`, or `MacOS/DeepSeek Harness` literal with the brand name again. |
| `apps/desktop/cli/dsh`, `apps/desktop/cli/dsh.cmd` | The installed `dsh` launchers execute `WASDEngine` and `WASDEngine.exe`. | +1 −1 each | Take upstream's side and rename the executable again; the Desktop drift spec fails until the launchers match the brand. |
| `apps/desktop/renderer/assets/welcome-brand.svg` | The first-run window's DeepSeek wordmark is replaced by the WASDEngine wordmark in the same 472 × 40 view box. | +5 −32 | Keep the fork's file (`git checkout --ours`) and port any change to its size or color variables. |
| `apps/desktop/tests/{background-notice,cli-launcher,desktop-package-environment,main-startup,package-macos,quit-confirmation,tray,welcome-startup}.spec.ts`, `apps/desktop/tests/expected/{about-panel.json,application-menu-*.json,fatal-*.txt,welcome/*.txt}` | Expectations name WASDEngine, its scheme, and its bundle identifier. | 1–8 lines each | Take upstream's side, re-apply the literal edits, run `pnpm exec vitest run apps/desktop/tests -u` to rewrite the file snapshots, and check that the remaining diff only replaces the product name. |
| `packages/util/home-paths/tests/home-paths.spec.ts`, `packages/shell/shell-env/tests/shell-env.spec.ts` | Expect the `~/.wasdengine` default home. | +7 −7, +1 −1 | Take upstream's side and replace the default-home expectations again. |
| `packages/context/agent-instructions/tests/agent-instructions.spec.ts` | Every `~/.dsh` literal is `~/.wasdengine`, because `scopeForDisplayPath` recognizes the harness-home `AGENTS.md` by its default display path. Nine exact-boundary rendering tests carry recomputed byte budgets and content sizes for the 7-byte-longer path; the bare-notice test uses `$DSH_HOME/AGENTS.md`, because no budget reproduces it with `~/.wasdengine/AGENTS.md`. | +78 −78 | Take upstream's side and run `sed -i '' -e 's,~/\.dsh,~/.wasdengine,g' -e "s,join(home, '\.dsh/AGENTS\.md'),join(home, '.wasdengine/AGENTS.md'),g"` on the file. For a rendering test that then fails on an exact byte count, measure the new value with `renderAgentInstructions` and keep the boundary the test title states. |

## Files the fork adds

| Path | Purpose |
|---|---|
| `.github/README.md` | Repository front page; GitHub shows `.github/README.md` before the upstream root `README.md`, which stays unmodified. |
| `wasdengine/FORK.md` | This file. |
| `wasdengine/upstream-prune.txt` | The upstream paths the fork deletes on every merge, one literal path or directory per line. |
| `wasdengine/sync-upstream.sh` | Merges an upstream ref, deletes the pruned paths, and commits a merge without other conflicts. |
| `packages/client/ui-settings-account/tests/wasdengine-onboarding-balance.client.spec.ts` | Pins the empty-wallet onboarding rule. |
| `packages/bundle/base/wasdengine/gateway.cordis.patch.yml` | WASDEngine service overlay of dsh-base: provider endpoints, the credential name, the model catalog, and the Session log request field and the Session OpenTelemetry export switched off. |
| `packages/bundle/sdk-minimal/wasdengine/gateway.cordis.patch.yml` | The `llm-deepseek` and `session-log-deepseek` rows of the service overlay for the standalone sdk-minimal tree. |
| `packages/bundle/web-app/wasdengine/telemetry.cordis.patch.yml` | Desktop product analytics and its OpenTelemetry exporter switched off, and the account menu's Feedback item pointed at the WASDEngine issue tracker. |
| `packages/bundle/web-app/wasdengine/gamedev.cordis.patch.yml` | The `gamedev` agent preset (Game developer) and the preset registry default. |
| `packages/bundle/web-app/wasdengine/skills/<name>/SKILL.md` | Bundled skills `godot-project`, `phaser-game`, and `game-design-doc`. |
| `packages/bundle/web-app/tests/wasdengine-overlay.spec.ts` | Drift spec for the four patch files, the composition of every `PROFILE_TEMPLATES` profile, and the skills. |
| `apps/desktop/src/wasdengine-brand.ts` | `WASDENGINE_DESKTOP_BRAND`, the Desktop identity, and `brandDesktopDictionaries`, the shell copy substitution. It has no imports, so the sandboxed preloads can bundle it. |
| `apps/desktop/scripts/wasdengine-builder-config.mjs`, `.d.mts` | `applyWasdengineBrand`, which applies the identity to the electron-builder configuration and refuses DeepSeek bundle identifiers and update feeds. |
| `apps/desktop/scripts/wasdengine-render-icons.ts` | Renders the icon PNGs, the tray ICO, and the home animation atlas of `ui-brand-official` from the SVG sources. |
| `apps/desktop/wasdengine/icon-{macos,windows}.{svg,png}`, `tray-windows.ico` | Placeholder WASD keycap icons and their vector sources; `icon-windows.svg` is also the source of the Web install icons and the home atlas. |
| `apps/desktop/tests/wasdengine-brand.spec.ts` | Drift spec for the Desktop identity and the home atlas. |
| `packages/client/ui-brand-official/src/client/wasdengine-brand.tsx` | `WasdengineMark`, the keycap mark in the current ink, and `applyWasdengineBrand`, which registers it in the sidebar and hero brand-mark slots. |
| `packages/client/ui-brand-official/tests/wasdengine-brand.client.spec.tsx` | Drift spec for the occupants and for the keycap geometry the mark shares with the Desktop icon sources and the favicons. |
| `apps/web/scripts/wasdengine-app-icons.ts` | Renders the Web install icons from `icon-windows.svg` with the upstream variants and maskable scale. |
| `apps/web/tests/wasdengine-app-icons.spec.ts` | Pins the install tile rewrite and checks that the committed PNGs are current renders. |

The fork's patch files close their bundles' patch lists, so every shipped profile loads them, existing profiles included, and the profile and home patches can still override them. The dsh-base overlay reaches `web` (also the Desktop's `desktop` profile), `acp`, `headless`, and `sdk`, the profile the TypeScript SDK launches by default, as well as any profile that `dsh plugin` creates from dsh-base. The sdk-minimal overlay reaches `sdk-minimal`, and the two dsh-web-app files reach `web` and `desktop`. The fork keeps no `README.md` under `packages/`, because package README gates would claim it.

## What the overlay configures

The fork's files set these rows in every shipped profile that mounts them; every other row keeps its upstream configuration. The dsh-base overlay is `packages/bundle/base/wasdengine/gateway.cordis.patch.yml`, and the sdk-minimal overlay, `packages/bundle/sdk-minimal/wasdengine/gateway.cordis.patch.yml`, repeats the two rows that the standalone sdk-minimal tree mounts:

| Row | Set by | Setting | Effect |
|---|---|---|---|
| `deepseek-account` | dsh-base overlay | `platformOrigin` = PLATFORM, `inferenceOrigin` = API, `allowLoopbackHttp: true`, upstream `desktopPlatform` restated | Account sign-in uses browser PKCE against PLATFORM, and the account token is released for model and file requests only to API. Every profile that mounts the row uses this PLATFORM, so a sign-in that one profile stores survives the startup of the others, where the provider deletes a stored sign-in whose issuer is not PLATFORM. `headless` disables the row. |
| `llm-deepseek-account` | dsh-base overlay | `baseURL` = API | `POST API/v1/messages` and `GET API/models` with `x-dsh-auth-token`. |
| `llm-deepseek` | both overlays | `baseURL` = API/anthropic, `apiKeyEnv: WASDENGINE_API_KEY`, catalog = the upstream `deepseek-flash` entry; the sdk-minimal copy restates its `defaultContextWindow` and `streamIdleTimeoutMs` | `POST API/anthropic/v1/messages` with `x-api-key`; an ambient `DEEPSEEK_API_KEY` is never sent. |
| `session-log-deepseek` | both overlays | `enabled: false` | Requests carry no `dsh_session_log` field; the Web and Desktop Settings can turn it back on. |
| `session-telemetry-otel` | dsh-base overlay | `disabled: true` | No Session export to the DeepSeek OpenTelemetry collector. |
| `desktop-product-telemetry`, `product-analytics` | `packages/bundle/web-app/wasdengine/telemetry.cordis.patch.yml` | `disabled: true` | No Desktop product analytics export to the DeepSeek collector. |
| `ui-settings-account` | `packages/bundle/web-app/wasdengine/telemetry.cordis.patch.yml` | `contactFormUrl` = `https://github.com/WASDEngine/WASDEngine/issues/new` | The account menu's Feedback item opens GitHub's new-issue page of WASDEngine/WASDEngine instead of DeepSeek's Feishu form, the code default in `packages/client/ui-settings-account/src/contact-config.ts`. |

The Feedback item opens `contactFormUrl` with the query parameters that upstream's `contactUrl` (`packages/client/ui-settings-account/src/client/contact-url.ts`) appends to any configured URL: `hide_uid=1`, `hide_source=1`, `hide_harness_version=1`, and `hide_device_info=1`; `prefill_uid`, the WASDEngine account id, while the user is signed in; `prefill_harness_version`, the client version; and `prefill_device_info`, which on Desktop is the platform, OS version, architecture, CPU model, and memory size, and on Web is the browser's user agent, followed by `screen_resolution=<width>x<height>` in device pixels. `prefill_source` is omitted because `contactSource` is empty. GitHub fills no form field from these parameters, but github.com receives them in the request URL. An empty `contactFormUrl` fails the row's config validation, which stops the account settings plugin, and `null` selects the Feishu default, so neither can switch the item off.

Web search needs no row: the default Search API provider follows the conversation's DeepSeek route, so it sends `POST API/v1/tools/search` with `Authorization: Bearer <WASDEngine token>`, or with `x-dsh-auth-token` on the account route. The account provider also calls `PLATFORM/auth-api/v0/dsh/auth_init`, `auth_exchange`, `auth_cancel`, `PLATFORM/auth-api/v0/users/current` and `logout`, `PLATFORM/api/v0/users/get_user_summary`, `get_unnotified_bonuses`, and `ack_bonus_notified`, and opens the pages `PLATFORM/dsh/authorize`, `/dsh/authorized`, `/usage`, and `/top_up`. Images use the Files API under the Messages base and fall back to inline base64 when the gateway answers 404.

### Service origins

PLATFORM is the anchored `&wasdengine-platform-origin` expression in the dsh-base overlay, with production default `https://app.wasdengine.com`; API is the anchored `&wasdengine-api-origin` expression, with production default `https://api.wasdengine.com`. Both read `WASDENGINE_ORIGIN` from the environment that launched the harness, then from `$DSH_HOME/.env`, and that one value replaces both defaults, for example `http://127.0.0.1:8000` for a local backend, so a deployment that it names must serve both the Platform and the API routes. The expressions read the launch-environment snapshot rather than `process.env`, because the launcher also copies a project directory's `.env` into `process.env`; a cloned repository therefore cannot redirect WASDEngine credentials. `llm-deepseek-account` aliases the API anchor. A YAML alias cannot append a path or reach another file, so `llm-deepseek.baseURL` repeats the API expression inside `new URL('/anthropic', ...)` in the dsh-base overlay and again in the sdk-minimal overlay, and the drift spec fails unless every copy matches and the two expressions differ only in their defaults.

To change a production hostname, edit its default in the anchored expression (and, for API, in both `llm-deepseek` copies), update `PLATFORM_ORIGIN` or `API_ORIGIN` in the drift spec, and run it. Origins must be HTTPS; the account provider accepts HTTP only for `localhost`, `127.0.0.1`, and `[::1]`. The overlay's expressions resolve their endpoint through the launch-environment trust layers; `scripts/verify-config-source-ownership.ts` checks only `packages/*/*/cordis.patch.yml` and `packages/*/*/presets/*.patch.yml`, so it does not read the fork's files.

### Game developer preset

`gamedev.cordis.patch.yml` inserts `preset-gamedev`, a copy of the upstream `standard` preset with three differences: the display fields (`name: Game developer`, `description`, `order: 0`), the WASDEngine persona prefix, and `bundledSkillDir` on its `skill-filesystem` row. It then sets `agent-preset-registry` `default: gamedev`; a user's Settings choice (`selectedDefault`) still wins, and `standard` stays in the roster. The persona text may use only the `{{model}}` and `{{provider}}` prompt variables. The bundled skills resolve from the installed `@deepseek-ai/dsh-web-app` package at rank 600, so a project skill with the same name under `.agents/skills/` or `.dsh/skills/` replaces it, and each `SKILL.md` stays under 8192 characters, the size above which the preset's tool-result pruner trims a loaded skill. The skills keep all instructions in `SKILL.md` and ship no scripts, because the Host reads skill files with its own file APIs while shell commands may not reach files packaged inside the Desktop application archive.

## Desktop identity

`apps/desktop/src/wasdengine-brand.ts` defines the Desktop identity once. Packaging reads it through `applyWasdengineBrand`, and the shell reads it for the About panel, the deep-link scheme, and its copy.

| Surface | WASDEngine | Stock DeepSeek Harness |
|---|---|---|
| Application and executable | `WASDEngine.app` (`Contents/MacOS/WASDEngine`), `WASDEngine.exe` | `DeepSeek Harness.app`, `DeepSeek Harness.exe` |
| Bundle identifier of unsigned builds | `com.wasdengine.desktop` | `com.deepseek.harness` |
| Deep link | `wasdengine://open` | `dsh://open` |
| Electron data and logs (from the packaged `productName`) | `~/Library/Application Support/WASDEngine`, `~/Library/Logs/WASDEngine` | `@deepseek-ai/dsh-desktop` |
| Harness home | `~/.wasdengine` | `~/.dsh` |
| Publisher and copyright | WASDEngine | Hangzhou DeepSeek Artificial Intelligence Co., Ltd.; DeepSeek Harness |
| macOS About panel | WASDEngine (built on DeepSeek Harness) | DeepSeek Harness |
| Icons and first-run wordmark | WASD keycap placeholder | DeepSeek whale |

The two products therefore keep separate credentials, Sessions, profiles, profile locks, settings, and single-instance locks, and neither handles the other's deep link. A WASDEngine install starts with an empty home. To keep a DeepSeek Harness install's Sessions, copy its `sessions/` directory and the `attachments/` directory that holds their images into `~/.wasdengine`, and `storages/` too for its workspace list and scheduled tasks. Copy nothing else, and never set `DSH_HOME` to `~/.dsh`. A copied profile patch (`profiles/*/cordis.patch.yml`) or home `cordis.patch.yml` replaces whole overlay rows: an `llm-deepseek` row that a stock Models page edit wrote, for example, keeps only that edit, so model requests go to DeepSeek with `DEEPSEEK_API_KEY`. A copied `settings.yaml` migrates into the profile patch with the same effect, `.credentials.yaml` holds DeepSeek Harness's saved keys and sign-in, and a shared home makes each product's account provider delete the other's sign-in. Upstream documentation, such as `apps/desktop/README.md` and `docs/`, keeps the DeepSeek Harness names and `~/.dsh`; on the fork, read them with the substitutions in this table.

`brandDesktopDictionaries` replaces "DeepSeek Harness", and "Harness" on its own, with WASDEngine in every message of the eight shell dictionaries, in place, so the exported dictionaries and the resolved locales agree. "DSH" and references to DeepSeek models stay.

Release builds take their bundle identifier from `DSH_DESKTOP_APP_ID`; `applyWasdengineBrand` refuses an identifier under `com.deepseek`, which the upstream templates (`apps/desktop/.env.*.example`, `apps/desktop/config/*-packaging/*.env.example`) still name.

`WASDENGINE_DESKTOP_BRAND.updateOrigin` is unset, so `applyWasdengineBrand` refuses every configuration that embeds an update feed. Unsigned builds embed none and package normally. A signed build always embeds one, so it fails when electron-builder loads the configuration, and no WASDEngine build can carry DeepSeek's `https://download.deepseek.com` feed. To ship updates, set `updateOrigin` to the HTTPS origin of a WASDEngine update service and make the release pipeline produce that origin: the test deployment reads it from `DOWNLOAD_TEST_ORIGIN`, while the production deployment's fixed origin in `apps/desktop/scripts/desktop-auto-update-environment.mjs`, and the DeepSeek publication tests that pin it, must change. Also set an updater cache directory, because electron-builder derives it from the npm name `@deepseek-ai/dsh-desktop`, which a stock install shares.

After changing an icon source, run `pnpm exec tsx scripts/wasdengine-render-icons.ts` in `apps/desktop` and `pnpm exec tsx scripts/wasdengine-app-icons.ts` in `apps/web`, and commit the PNG, ICO, and WebP files; electron-builder derives the macOS icon set from the 1024 px PNG. The npm scopes, the `dsh` command, `DSH_*` variables, `x-deepseek-harness-*` headers, Cordis row ids, and versions keep their upstream names.

## Web UI identity

The Web UI, which the Desktop app also renders, draws the WASDEngine keycap mark where upstream draws DeepSeek's whale. `ui-brand-official`, which the Web and Desktop compositions mount, registers `WasdengineMark` from `src/client/wasdengine-brand.tsx` in the `sidebar.brand.mark` and `conversation.hero.brand.mark` slots in every build profile, so the `FishLogo` fallback of `ui-sidebar` and the hero fish of `ui-conversation` do not render. The sidebar name keeps its "DSH Local Build" fallback, and no build registers the DeepSeek Harness wordmark. The mark is the four keycaps of the Desktop icon sources in the current ink, with their letters cut out.

| Surface | WASDEngine | Stock DeepSeek Harness |
|---|---|---|
| Sidebar and blank-home hero mark | WASD keycap mark | Whale (`FishLogo`, the hero fish) |
| Blank-home click animation | The keycaps arrive, W, A, S, D, and W press, and the keycaps leave | Whale breach |
| Favicon | WASD keycap mark | Whale |
| Install icons | Windows icon tile, square and without its shadow | Whale tile |
| Install name, short name, and Apple title | WASDEngine | DeepSeek Harness, DSH, DSH |

## Merge checklist

Run these after every merge and before pushing it. The diffs below show what upstream changed since the previous merge: use `HEAD...MERGE_HEAD` while the merge is uncommitted, and `HEAD^1...HEAD^2` once the merge commit exists (the sync script commits a merge that has no conflicts).

1. Review upstream changes to the protocol and configuration the overlay depends on, and update the overlay or the WASDEngine backend when a key, endpoint, header, or response field changed: `git diff HEAD^1...HEAD^2 -- packages/credentials/deepseek-account packages/credentials/deepseek-account-platform packages/llm/llm-deepseek packages/llm/llm-deepseek-api-key packages/llm/llm-deepseek-account packages/web/web-deepseek-api`.
2. Review the bundle rows and the shipped profile templates: `git diff HEAD^1...HEAD^2 -- packages/bundle/*/cordis.patch.yml packages/bundle/web-app/presets/standard.patch.yml packages/util/official-bundles/src/bundles.ts`. Port every change to `standard` into the `gamedev` preset, and switch off or repoint any new row that sends data to a DeepSeek host. When a new profile template composes a bundle that mounts a patched row outside dsh-base, append a fork patch file to that bundle's `dsh.bundle.patch` and add it to `FORK_PATCHES` in the drift spec.
3. Run the drift spec with the bundle tests: `pnpm exec vitest run packages/bundle packages/client/ui-settings-account/tests`. Then list upstream tests and scripts that still name workflow files: `git grep -l -e '\.github/workflows/' -e '\.\./workflows/' -- '*.spec.ts' '*.spec.tsx' '*.mjs'`. Expected hits are `.github/issue-management/policy.test.mjs` (see Known limitations) and files that use workflow paths only as strings and pass: `.github/review-ownership/check-approval.mjs` and its test, `apps/desktop/tests/desktop-package-selection.spec.ts` and `desktop-publish-route.spec.ts`, and `scripts/cua-helper/build-inputs.spec.ts` and `select-artifact.spec.ts`. A new hit that fails with `ENOENT` belongs in `upstream-prune.txt`.
4. Run the Desktop drift spec and the tests the fork edits: `pnpm exec vitest run apps/desktop/tests packages/util/home-paths/tests packages/shell/shell-env/tests packages/context/agent-instructions/tests`. When a file snapshot fails only because upstream changed shell copy, rerun with `-u` and check that the diff names WASDEngine. Then look for new upstream literals the brand does not reach: `git grep -n -e "DeepSeek Harness" -e "dsh://" -e "com\.deepseek\.harness" -- apps/desktop/src apps/desktop/scripts apps/desktop/cli`. Expected hits are the locale dictionaries, the factory defaults in `scripts/electron-builder-config.mjs` that `applyWasdengineBrand` replaces, the Windows installer test identifier in `scripts/test-windows-installer.mjs`, and the notarization proxy lock path in `scripts/macos-notarization-proxy.ts`; route any other hit through `WASDENGINE_DESKTOP_BRAND`.
5. Run the Web brand drift specs: `pnpm exec vitest run packages/client/ui-brand-official apps/web/tests/app-icons.spec.ts apps/web/tests/wasdengine-app-icons.spec.ts`. Then look for brand marks the occupants do not reach: `git grep -n -e FishLogo -e FISH_LOGO_PATH -e BrandWordmark -e running-whale -- 'packages/*/*/src/**' 'apps/web/src/**'`. Expected hits are the definitions in `ui-primitives`, the `ui-sidebar` and `ui-conversation` fallbacks that the occupants replace, the unregistered `Brand.tsx` of `ui-brand-official`, the LiveShare viewer brand, and the `ui-chat` running icon; route a new hit that ships through `wasdengine-brand.tsx`.
6. Run the package and configuration gates: `pnpm run constraints`, `pnpm run verify-cordis-config`, `pnpm run verify-product-use`, and `pnpm run verify-default-product-isolation`, or the whole `pnpm run hygiene` aggregate.
7. Reinstall and build: `pnpm install`, then `pnpm run build`. Then run the install-metadata check against the built Web UI: `pnpm exec vitest run --config vitest.web.config.ts apps/web/tests/pwa-manifest.e2e.ts`.
8. Run the documentation checks: `pnpm run test:docs`.
9. After a change under `apps/desktop`, package once with `pnpm run package:desktop:mac:arm64:unsigned --dir` and check `apps/desktop/.desktop-build/targets/mac-arm64/unsigned-artifacts/mac-arm64/WASDEngine.app/Contents/Info.plist` for the WASDEngine name, bundle identifier, and URL scheme. Do not open the application from a script, because launching it registers its URL scheme with Launch Services.

## CI policy

- The fork carries none of upstream's GitHub Actions workflows, composite actions, or Dependabot configuration: they target DeepSeek's self-hosted runners, secrets, release channels, and repository settings, and Dependabot pull requests would conflict with upstream merges. `upstream-prune.txt` lists them with the specs that read them, and the sync script deletes them on every merge.
- Fork-owned workflows are named `.github/workflows/wasd-*.yml` (composite actions `.github/actions/wasd-*`), which the sync script keeps. The fork has none yet; a first one would run `pnpm install`, `pnpm run build`, and the checks in steps 3 to 5 of the merge checklist.
- Upstream release and packaging tooling that reads the deleted workflows, such as the Desktop publication targets in `apps/desktop/scripts/desktop-publish-targets.ts` and the CUA helper artifact selection in `scripts/cua-helper/select-artifact.ts`, describes DeepSeek's release pipeline and is not used by the fork.

## Known limitations

- Interface text outside the Desktop shell still names DeepSeek: the sign-in prompt, the account menu and pages, the first-run Preview Notice, the Models page, the onboarding credit page (shown with Continue, because WASDEngine accounts report no wallets), the Web search and Session log settings, the `dsh` help text, and the Windows installer messages in `apps/desktop/installer/locales/*.json` and `apps/desktop/installer/extract-report.h`; [.github/README.md](../.github/README.md#interface-text-that-names-deepseek) lists the Web UI copy. Official-profile builds title the window "DeepSeek Harness" (`scripts/client-build-environment.ts`); unsigned builds show "DSH Local Build".
- Two whale images remain outside the brand slots: the chat's running indicator animates a whale tail (`RunningWhaleTail` and `assets/running-whale@2x.png` in `ui-chat`), and the optional LiveShare viewer page registers `FishLogo` as its sidebar mark, which shadows the fork's mark on that page. The `ui-brand-official` README still describes upstream's official sidebar artwork and whale animation.
- Installer and archive files keep upstream's `deepseek-harness-<version>-<os>-<arch>` names, because DeepSeek's numbering, upload, website, and retention scripts parse them; the application inside is `WASDEngine.app`.
- `pnpm run dev:desktop` registers `wasdengine://` through a development bundle that keeps the name Harness Dev, and its About panel and tray read the upstream icons in `apps/desktop/resources`. A development bundle created before the brand change keeps `dsh://` until `apps/desktop/.desktop-build/development` is deleted.
- The Desktop installs its command at `/usr/local/bin/dsh`, the path a stock DeepSeek Harness Desktop uses; the command manager reports whichever installation takes precedence.
- The packaged application omits Electron's `LICENSE` and `LICENSES.chromium.html`, as upstream's does.
- The legacy "DeepSeek (legacy)" web search provider keeps its upstream configuration: when a user selects it, it sends that user's own `DEEPSEEK_API_KEY` to the DeepSeek API, never the WASDEngine token.
- The account menu's Feedback item sends the signed-in user's WASDEngine account id, the client version, and the device description to github.com in its URL, as [What the overlay configures](#what-the-overlay-configures) lists, because upstream's `contactUrl` appends them to every form URL. The new-issue page offers upstream's issue templates, which the fork keeps in `.github/ISSUE_TEMPLATE`.
- At startup the account provider deletes a stored sign-in whose issuer is not PLATFORM, so pointing `DSH_HOME` of both products at one home removes the other product's sign-in.
- The optional LiveShare bundle (`@deepseek-ai/dsh-experimental-liveshare`), which the plugin manager offers, keeps `owner-shares.json`, the relay credential `owner-credential.json`, and the fork registry `forks.json` in `~/.dsh/liveshare/`, the directory a stock DeepSeek Harness install uses, because `defaultOwnerStateFile` in `packages/experimental/liveshare/src/host/share-host.ts` reads `process.env.DSH_HOME` and falls back to `~/.dsh`, and the launchers do not export the home they resolve. Setting `LIVESHARE_OWNER_STATE_FILE` to a path under `~/.wasdengine` in the launch environment keeps the three files there.
- `pnpm run test:issue-management` fails 3 of its 51 tests, because `.github/issue-management/policy.test.mjs` reads the deleted `.github/workflows/issue-policy.yml` and `issue-lifecycle.yml`. `pnpm run check:all` and the CI aggregates that include the shared static gates (`check:ci`, `check:ci:linux-primary`, and `check:ci:static`) run it and fail at that gate; `pnpm run test:approval-policy` passes. `package.json` and `scripts/run-gates.ts` keep upstream's gate lists, so they merge without conflicts.
- A Settings or Models page edit of a row copies that row's composed configuration, including the PLATFORM and API expressions, into the profile patch, and so does each Desktop onboarding step, which saves its progress in the `ui-settings-account` row together with `contactFormUrl`. Later fork changes to that row reach the profile only after the user resets it.
- `pnpm run test:snapshot` fails 11 TypeScript SDK replays in `snapshots/sdk/sdk.snapshot.ts`, and the ACP, headless Session, and corpus replays pass. Ten recorded Sessions expect `session-log-deepseek/delivery-accepted` events, which requests without `dsh_session_log` never produce. `account-provider-signout` expects the `web_search` tool, which the replay's placeholder `DEEPSEEK_API_KEY` no longer enables, because the fork's routes read `WASDENGINE_API_KEY`.
- Other upstream end-to-end and Web test lanes compose the shipped bundles; a lane that expects the upstream default preset, telemetry rows, or DeepSeek endpoints describes upstream behavior and may fail on the fork.
