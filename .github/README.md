# WASDEngine

WASDEngine is an agent harness for game development: it designs, builds, runs, and debugs games with you from the Web UI or the Desktop app. It is built on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) and serves models through the WASDEngine service.

WASDEngine is an independent project. It is not affiliated with, endorsed by, or sponsored by DeepSeek. This page uses the DeepSeek and DeepSeek Harness names only to describe the project WASDEngine is built on, the DeepSeek services the fork turns off or replaces, and the DeepSeek model it serves; interface text inherited from DeepSeek Harness still names DeepSeek in the places [listed below](#interface-text-that-names-deepseek). As the DeepSeek Harness [brand guidelines](../BRAND_GUIDELINES.md) state, "DeepSeek Harness" is a registered trademark of DeepSeek.

## What the fork changes

- **WASDEngine service by default.** Model requests, web search, and account sign-in go to the WASDEngine service instead of DeepSeek from every `dsh` profile: the Web UI (`dsh web`), the Desktop app, `dsh acp`, `dsh sdk` and the SDK clients that launch it, `dsh --profile headless`, and `dsh --profile sdk-minimal`. The default model is `deepseek-flash` (DeepSeek-V4.1-Flash), served through the service.
- **Game development by default in the Web UI and the Desktop app.** New sessions there use the Game developer agent preset with bundled skills for Godot 4 (`godot-project`), Phaser (`phaser-game`), and design planning (`game-design-doc`), and the upstream presets, including Standard, remain available. The preset and its skills ship in the Web bundle `@deepseek-ai/dsh-web-app`, which no other shipped profile loads, so `dsh acp`, `dsh sdk`, `dsh --profile headless`, and `dsh --profile sdk-minimal` keep upstream's agent without them.
- **No upstream CI.** The fork deletes upstream's GitHub Actions workflows, Dependabot configuration, and the specs that read them ([wasdengine/upstream-prune.txt](../wasdengine/upstream-prune.txt)), because they target DeepSeek's runners and release channels.
- **No transcript or analytics uploads.** Model requests from every profile carry no copy of the Session log (`dsh_session_log`) unless a user turns the Session log option on in Settings, and the Session OpenTelemetry export and Desktop product analytics, which report to DeepSeek's collector, are switched off.
- **Its own identity and data.** The Web UI and the Desktop app show the WASD keycap mark instead of DeepSeek's whale in the sidebar, beside the home headline, in the home's click animation, and as the browser tab icon, and the Web UI installs from the browser as an app named WASDEngine with the keycap icon. The Desktop app is called WASD Engine and has its own icon, bundle identifier (`com.wasdengine.desktop`), deep link (`wasdengine://open`), and application data folder; its first-run welcome and onboarding introduce WASD Engine for game development, and the sign-in and account text names WASD Engine accounts. WASDEngine keeps sessions, settings, and credentials in `~/.wasdengine`, so it can be installed next to DeepSeek Harness (`~/.dsh`) without either reading the other's data; only the optional LiveShare plugin keeps its files in `~/.dsh/liveshare/` (see the [known limitations](../wasdengine/FORK.md#known-limitations)). WASDEngine builds never update themselves from DeepSeek's download server.

The service and agent changes are configuration, and the identity is a Desktop brand module, a brand-mark occupant for the Web UI, and copy rewrites of two client dictionaries; [wasdengine/FORK.md](../wasdengine/FORK.md) lists every file the fork adds or modifies and how upstream releases are merged.

## Run from source

Install Node.js 24.9 or later and pnpm 11.28.5. Node.js 25 and later ship without Corepack, so install pnpm with `npm install -g pnpm@11.28.5`. Then run:

```sh
git clone https://github.com/WASDEngine/WASDEngine.git
cd WASDEngine
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm dsh web` serves the Web UI at `http://127.0.0.1:3080` and opens it in the default browser; pass `--no-open` to skip the browser. `pnpm run dev:desktop` builds and starts the Desktop app from the same checkout. `pnpm run package:desktop:mac:arm64:unsigned` builds an unsigned `WASD Engine.app` and disk image for Apple silicon Macs; add `--dir` to stop at the app.

Data lives in `~/.wasdengine` unless `DSH_HOME` names another directory. To keep your Sessions from a DeepSeek Harness install, copy the `sessions` and `attachments` directories of `~/.dsh` into `~/.wasdengine`, and `storages` too if you want its workspace list and scheduled tasks. Do not copy its `profiles` directory, `cordis.patch.yml`, `settings.yaml`, or `.credentials.yaml`, and do not set `DSH_HOME` to `~/.dsh`: the configuration files replace the WASDEngine service settings with DeepSeek's, `.credentials.yaml` holds DeepSeek Harness's keys and sign-in, and in a shared home each product deletes the other's sign-in at startup.

## Connect to the WASDEngine service

The harness signs in at `https://app.wasdengine.com` and sends model, web search, and file requests to `https://api.wasdengine.com`. To use another deployment, such as a WASDEngine service running on your machine, set `WASDENGINE_ORIGIN` in the environment that launches the harness; it replaces both origins:

```sh
WASDENGINE_ORIGIN=http://127.0.0.1:8000 pnpm dsh web
```

The Desktop app reads `WASDENGINE_ORIGIN` from its launch environment first and from the `.env` file of the harness home (`~/.wasdengine/.env` unless `DSH_HOME` points elsewhere) second. On macOS that launch environment includes the variables your login shell exports, for example from `~/.zshrc` or `~/.zprofile`, even when the app starts from the Finder; on Windows, an app started from the Start menu sees your user and system environment variables but not variables set in a terminal. To point the Desktop app at another deployment, put the line `WASDENGINE_ORIGIN=http://127.0.0.1:8000` in that `.env` file, and remove any `WASDENGINE_ORIGIN` export from your shell startup files or your Windows environment variables, because those take precedence over the file. A `.env` file in a project directory cannot set it, so a cloned repository cannot redirect your WASDEngine credentials. Origins other than `localhost`, `127.0.0.1`, and `[::1]` must use HTTPS.

Sign in with either credential:

- **WASDEngine account.** Choose **Sign in** in Settings → Account, or on the first-run screen. The harness opens the WASDEngine sign-in page in your browser and stores the resulting token locally.
- **WASDEngine API token.** Paste the token as the API key of the DeepSeek provider on the Settings → Models page, or export it as `WASDENGINE_API_KEY`.

Profiles that use the same harness home share the stored sign-in and API token. `dsh acp` sends model requests with the API token. An SDK client selects the route in its `initialize` request: provider `deepseek-account` uses the sign-in, and `deepseek-official` uses the API token. `dsh --profile headless` and `dsh --profile sdk-minimal` keep no credential store, so they read the token from the `WASDENGINE_API_KEY` environment variable.

## Interface text that names DeepSeek

Some interface text inherited from DeepSeek Harness still names DeepSeek, although sign-in, model, and search requests go to the WASDEngine service:

- The first-run Preview Notice about DeepSeek Harness 0.2.
- The Models page and the model menu, which call the provider DeepSeek and the sign-in route DeepSeek Account.
- The web search providers DeepSeek Search API, DeepSeek Fetch API, and DeepSeek (legacy), the Session log option "Help improve DeepSeek models and products", the plugin installation warning, and chat errors about the account sign-in.
- The `dsh` command help and the Windows installer messages.

The chat's running indicator still animates a small whale tail, and the optional LiveShare viewer page shows DeepSeek's whale as its sidebar mark.

## Project skills

The bundled skills load in the Game developer preset. A skill directory with the same name under `.agents/skills/` or `.dsh/skills/` in your project replaces the bundled copy, so a team can pin its own engine conventions.

## License

WASDEngine is distributed under the MIT License in [LICENSE](../LICENSE), which keeps the DeepSeek Harness copyright notice. Third-party dependencies and their licenses are listed in [THIRD_PARTY_NOTICES.md](../THIRD_PARTY_NOTICES.md).
