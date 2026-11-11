# Use the Web UI

English | [中文](index.zh.md)

Start the Web UI as the [front page](https://github.com/WASDEngine/WASD-Engine#run-from-source) describes; the command prints its URL. This guide begins after that server is running. The `dsh` process uses its invoking directory as the default filesystem location, but a fresh Web UI has no selected workspace until you add one.

## Sign in

Choose **Sign in** in the Get started dialog or in the account menu at the bottom of the sidebar, then sign in to your WASD Engine account on the page that opens in your browser. Model requests then go to the WASD Engine service without restarting the server.

The [model configuration guide](./providers.md) covers other providers and custom OpenAI-compatible endpoints.

## Choose a workspace

Click **Choose workspace**, add the project directory where you started `dsh`, and select it. The session composer remains unavailable until a workspace is selected.

## Run a task

Start a session and send:

> Summarize this repository and identify its main packages.

The agent can read and edit workspace files, run commands, delegate work, and maintain a plan. The Web UI asks before operations that require approval under the active permission policy.

## Continue

- [Configure models](./providers.md)
- [Use the Python SDK](./python-sdk.md)
- [Publish the Web UI behind a reverse proxy](./public-deployments.md)
- [Uninstall WASD Engine](./desktop-uninstall-cleanup.md)
- [Use other CLI modes](../../../apps/cli/README.md)
- [Develop a plugin](../develop/basic/index.md)
