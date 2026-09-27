# Codex Router

Codex Router connects shells, messaging apps, and HTTPS clients to existing Codex chats.
Give each chat a local name, then send messages through the CLI or the gateway.

| Interface | Input and output |
| --- | --- |
| CLI | Text input, final replies, or completed messages as JSON Lines |
| SendBlue | Text, images, and files through a configured messaging line |
| HTTPS | Text requests, retained results, and completed commentary through SSE |

Follow-ups steer an active turn. Idle chats start a new turn.
The gateway saves accepted input and pending responses across restarts.

## Install

Install the published [npm package](https://www.npmjs.com/package/@skarian/codex-router).
Requires Node.js 20.17–20.x or 22.9 and newer.

```sh
npm install --global @skarian/codex-router@latest
```

On Windows PowerShell, use `npm.cmd` in place of `npm`.
No repository checkout or build step is required.

The command name is `codex-router`. The unscoped npm package `codex-router` is a different project.

Use an authenticated Codex installation on each execution host.
Local chats can use the Codex Desktop app on macOS or Windows.
Without a Desktop owner, the router needs an authenticated `codex` executable on `PATH`.
Linux servers use the CLI and app-server path.

For SSH agents, install standalone Codex on the remote host. Its daemon commands must work through noninteractive SSH.
See [SSH configuration](docs/cli-reference.md#configuration) for the installation and connection requirements.

## Update

Run the same command to install the latest published release:

```sh
npm install --global @skarian/codex-router@latest
```

Restart a running gateway after the update. Your configuration stays in `~/.codex-router/config.toml`.
To install a specific release, replace `@latest` with its version, such as `@0.0.1`.
Only explicit versioned releases reach npm. Commits to `main` do not publish or update installed copies.

## Configure a chat

Create `~/.codex-router/config.toml`. On Windows, this is `%USERPROFILE%\.codex-router\config.toml`.

```toml
[[agents]]
id = "home"
label = "Home Assistant"
cwd = "/absolute/path/to/project"
thread_id = "REPLACE_WITH_EXISTING_CHAT_ID"
model = "REPLACE_WITH_AVAILABLE_MODEL"
```

Replace the directory, chat ID, and model with values from your Codex host.
For a Desktop chat link such as `codex://threads/019...`, use only the ID after `/threads/`.
On Windows, use a TOML literal string for paths, such as `cwd = 'C:\projects\home'`.

The router uses existing chats. It does not create a chat from an agent name.
`id` and `label` are your local names. Optional `reasoning` sets the model effort.
Add `ssh_host = "my-server"` to an agent table to execute on an SSH host.

## Use the CLI

```sh
codex-router agents list
codex-router doctor

echo 'What is the thermostat set to?' |
  codex-router send home --stdin --json

codex-router cancel home
```

`--json` returns one final JSON object. `--stream` returns completed reasoning, commentary, and final messages as JSON Lines.
It does not stream individual tokens.

Local requests first look for the Desktop owner, then use an app-server connection.
SSH requests use a persistent remote app-server. Recovery follows the accepted turn without resending uncertain input.

Desktop-owned turns retain Desktop tools and permissions. Direct app-server turns use full access with approvals disabled.
`doctor` checks the CLI/app-server path and credential presence. It does not validate SendBlue credentials or fully diagnose Desktop IPC.

See the [CLI reference](docs/cli-reference.md) for commands, configuration, output, and errors.

## Run the gateway

Choose a connector and add its configuration:

- [SendBlue setup](docs/sendblue.md): API credentials, phone numbers, polling, attachments, and troubleshooting.
- [HTTPS setup](docs/https.md): LAN TLS, bearer tokens, requests, retained results, and SSE.
- [ESP32 example](examples/esp32-https/README.md): an HTTPS client with bounded parsing and reconnect support.

```sh
codex-router gateway
```

The gateway runs in the foreground. In another terminal, inspect its state:

```sh
codex-router gateway status --json
```

SendBlue polling needs outbound HTTPS only. It requires no public tunnel or inbound webhook.
HTTPS can remain on your local network. Both connectors are optional.

A route can accept both connectors for the same chat. They share Codex context, not a synchronized client transcript.
Each source receives responses to its own submissions. Participating requests share the final response when they steer one active turn.

See [gateway operation and recovery](docs/gateway.md) for process ownership, shutdown, and unresolved operations.
See [release qualification](docs/release-qualification.md) for platform results and known limits.
Desktop integration uses a private protocol that can change between Desktop releases.

## Develop

```sh
git clone https://github.com/Skarian/codex-router.git
cd codex-router
npm ci
npm test
npm link
```

`npm ci` builds the CLI through the `prepare` script. `npm link` installs the local `codex-router` command.
After source edits, run `npm run build` or `npm test`.

Git contains the source, tests, and documentation. It does not track `dist`.
`npm pack` and `npm publish` build the compiled files for the npm package.
Registry installations use those files without a TypeScript build.

See [publishing](docs/publishing.md) for package verification and release commands.

## License

[MIT](LICENSE).
