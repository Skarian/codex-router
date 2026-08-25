# CLI reference

## Usage

```text
codex-router [--config PATH] agents list [--json]
codex-router [--config PATH] doctor [--json]
codex-router [--config PATH] send AGENT_ID --stdin [--json | --stream]
codex-router [--config PATH] cancel AGENT_ID [--json]
```

`--config PATH` selects a TOML file. The default is
`~/.codex-router.toml`.

## Configuration

```toml
[[agents]]
id = "home"
label = "Home Assistant"
cwd = "/absolute/path/to/project"
thread_id = "019..."
model = "gpt-5.3-codex-spark"
reasoning = "medium"
```

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | yes | Local agent ID used by `send` |
| `label` | yes | Name shown by `agents list` and user-facing errors |
| `cwd` | yes | Absolute working directory for the turn |
| `thread_id` | yes | Existing Codex task ID |
| `model` | yes | Model selected for each turn |
| `reasoning` | no | Reasoning effort override; omission uses the model default |
| `ssh_host` | no | OpenSSH host or alias on which Codex runs |

Agent IDs are lowercase slugs that begin with a letter. IDs and labels are
unique within the file. Agents appear in file order.

When `ssh_host` is present, the router always uses a persistent remote
app-server. It connects with `ssh -T HOST codex app-server proxy` when the
control socket is running. When it is absent, the first send runs
`ssh -T HOST codex app-server daemon start`, waits for the control socket, and
then connects through the proxy. All other agent fields remain in this local
configuration; `cwd` and `thread_id` identify resources on the remote machine.
SSH credentials and connection options come from OpenSSH.

Durable daemon startup requires Codex installed through the official standalone
installer. Package-manager-only installations that previously worked through
remote stdio now fail before a turn is sent. The router never installs or
updates Codex, bootstraps an updater, enables remote control, restarts an
existing app-server, or stops the daemon it starts. Plain daemon startup does
not make the host available from signed-in mobile devices.

Install or update standalone Codex manually on an SSH target with:

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
```
The router adds encrypted SSH keepalives (`ServerAliveInterval=15` and
`ServerAliveCountMax=4`). If an SSH proxy disconnects after a turn is accepted,
the router reconnects within the original turn timeout, resumes the task, and
correlates the same turn before continuing. It never blindly submits the input
again.

## `agents list`

Lists the configured agent IDs and labels. This command reads and validates the
configuration file.

```sh
codex-router agents list
```

```text
ID    LABEL
home  Home Assistant
```

JSON mode returns an array in configuration order:

```sh
codex-router agents list --json
```

```json
[{"id":"home","label":"Home Assistant"}]
```

## `doctor`

Checks the configuration, Codex executable, configured directories, app-server
connection, and task IDs.

For remote agents, the Codex, directory, app-server, and task checks run through
SSH. Doctor is read-only: when the persistent app-server is absent, it reports
whether durable startup is available and does not start the daemon. In that
case the task is not checked; the first `send` performs startup.

```sh
codex-router doctor
codex-router doctor --json
```

JSON mode returns every check:

```json
{
  "ok": true,
  "checks": [
    {"name":"config","ok":true,"text":"Configuration is valid."},
    {"name":"codex","ok":true,"text":"codex-cli 0.146.0"},
    {"name":"agent:home:cwd","ok":true,"text":"Working directory is accessible."},
    {"name":"app-server","ok":true,"text":"App-server initialized over proxy."},
    {"name":"agent:home:thread","ok":true,"text":"Task exists."}
  ]
}
```

## `send`

Reads one message from stdin and resumes the selected task. When the task is
idle, the router starts a turn. When it is active, the router steers that turn.
In both cases it waits for the resulting shared turn's final response.

```sh
echo 'Turn off the living room light.' |
  codex-router send home --stdin
```

Plain mode prints the final response text. JSON mode returns one terminal
object:

```sh
echo 'Turn off the living room light.' |
  codex-router send home --stdin --json
```

```json
{"type":"completed","text":"The living room light is off."}
```

Stream mode emits completed semantic messages as JSON Lines:

```sh
echo 'Turn off the living room light.' |
  codex-router send home --stdin --stream
```

```jsonl
{"type":"reasoning","text":"I am checking the living room light."}
{"type":"commentary","text":"The living room light is on."}
{"type":"completed","text":"The living room light is off."}
```

Stream events contain completed reasoning summaries and commentary messages.
The terminal event is `completed` or `failed`.

Input is limited to 64 KiB of UTF-8 text. Each emitted semantic message is
limited to 256 KiB.

When `send` steers an active turn, it does not replay commentary that completed
before this invocation attached. Multiple senders steering the same turn can
receive the same final answer.

## `cancel`

Requests interruption of the selected task's active turn. It does not read
stdin, accept stream mode, or wait for the terminal interruption event.

```sh
codex-router cancel home
codex-router cancel home --json
```

An active task returns after Codex acknowledges the request:

```json
{"type":"interrupt_requested","agent":"home","turn_id":"019..."}
```

Cancelling an idle task is a successful no-op:

```json
{"type":"already_idle","agent":"home"}
```

A disconnect before the interrupt acknowledgment is ambiguous. The router does
not automatically repeat the interrupt request.

## Task handling

The app-server owns turn concurrency. An idle send uses `turn/start`; an active
send uses `turn/steer` with the exact active turn ID. The router does not queue,
interrupt, restart, or automatically resend ordinary input.

When native Codex remote control is running locally or on an agent's SSH host,
the router connects through `codex app-server proxy` and shares that app-server.
When the local control socket is absent, it owns
`codex app-server --listen stdio://` for the command. SSH agents never use
remote stdio; they start or reuse the persistent Codex daemon and connect by
proxy.

## Failures

JSON and stream modes use this shape:

```json
{"type":"failed","code":"app_server_disconnected","text":"The Codex app-server connection closed before the command completed.","ambiguous":true}
```

An uncertain delivery also includes `"ambiguous": true`. Treat that result as
potentially accepted and inspect the task before sending the same text again.

| Code | Meaning |
| --- | --- |
| `app_server_connect_failed` | The native app-server connection failed |
| `app_server_disconnected` | The app-server connection closed during the command |
| `app_server_protocol_failed` | The app-server handshake or response was invalid |
| `app_server_start_failed` | The local owned app-server or persistent remote daemon failed to start |
| `codex_unavailable` | Codex or its configured home directory is unavailable |
| `config_invalid` | The TOML file or one of its agent entries is invalid |
| `input_invalid` | The command arguments or stdin input are invalid |
| `interrupted` | The caller interrupted the turn |
| `output_too_large` | A semantic message exceeded 256 KiB |
| `thread_unavailable` | The configured task could not be resumed |
| `timeout` | The turn exceeded the router timeout |
| `turn_failed` | Codex ended the turn without a final response |
| `unknown_agent` | The requested agent ID is absent from the configuration |
| `working_directory_invalid` | The configured working directory is unavailable |

## Exit codes

| Exit code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Configuration, validation, or runtime failure |
| `2` | Invalid command usage or input |
