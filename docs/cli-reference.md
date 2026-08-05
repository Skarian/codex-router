# CLI reference

## Usage

```text
codex-router [--config PATH] agents list [--json]
codex-router [--config PATH] doctor [--json]
codex-router [--config PATH] send AGENT_ID --stdin [--json | --stream]
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

Agent IDs are lowercase slugs that begin with a letter. IDs and labels are
unique within the file. Agents appear in file order.

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

Reads one message from stdin, resumes the selected task, starts a turn, and
waits for its final response.

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

## Task handling

The router serializes sends for each configured agent. A busy task returns
`agent_busy` immediately. Clients can submit another send after the active turn
finishes.

When native Codex remote control is running, the router connects through
`codex app-server proxy` and shares that app-server. When the control socket is
absent, it starts `codex app-server --listen stdio://` for the command.

## Failures

JSON and stream modes use this shape:

```json
{"type":"failed","code":"agent_busy","text":"Home Assistant is already working. Try again after the current turn finishes."}
```

An uncertain delivery also includes `"ambiguous": true`. Treat that result as
potentially accepted and inspect the task before sending the same text again.

| Code | Meaning |
| --- | --- |
| `agent_busy` | The configured agent already has an active turn |
| `app_server_connect_failed` | The native app-server connection failed |
| `app_server_disconnected` | The app-server connection closed during the command |
| `app_server_protocol_failed` | The app-server handshake or response was invalid |
| `app_server_start_failed` | The command-owned app-server failed to start |
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
