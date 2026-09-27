# CLI reference

## Usage

```text
codex-router [--config PATH] agents list [--json]
codex-router [--config PATH] doctor [--json]
codex-router [--config PATH] send AGENT_ID --stdin [--json | --stream]
codex-router [--config PATH] cancel AGENT_ID [--json]
codex-router [--config PATH] gateway
codex-router [--config PATH] gateway status [--json]
codex-router [--config PATH] gateway resolve ROUTE_ID EFFECT_ID failed [--json]
codex-router [--config PATH] gateway resolve ROUTE_ID EFFECT_ID accepted HANDLE [--json]
```

`--config PATH` selects a TOML file. The default is
`~/.codex-router/config.toml`.

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

Agent IDs are lowercase slugs that begin with a letter. IDs, labels, and task IDs are
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
the router keeps reconnecting, resumes the task, and correlates the same turn
before continuing. It waits until Codex finishes or the caller interrupts the
command, and it never blindly submits the input again.

The router has no turn-duration or inactivity timeout. Short connection,
handshake, and control-request timeouts only detect a stuck attempt. Read-only
operations may retry; a timed-out `turn/start` or `turn/steer` acknowledgment is
correlated by its client message ID without resending the input.

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

If a local control socket exists but cannot be connected, the router falls back
once to owned stdio. It does not delete the socket or start a local daemon.

## Gateway commands

See [Gateway setup and recovery](gateway.md) for the ordinary message flow and deployment steps.

`gateway` runs in the foreground. It does not accept `--json`, `--stream`, or `--stdin`.
Direct credentials are read from TOML. Environment references are resolved at gateway startup.
Other commands validate the gateway tables without resolving environment references.
Doctor reports whether credentials are present, without contacting Sendblue or printing their values.

`gateway status` and `gateway resolve` require the gateway to be stopped. Both commands acquire the state lock.
They fail with `gateway_running` while another process owns it.

Status JSON contains one `unresolved` array. Each entry contains `routeId`, `effectId`, and `kind`.
The `kind` value is `codex_admission` or `send`. An empty array means there are no unresolved effects.
Plain output contains one route, kind, and effect ID per line.

Resolution JSON has this shape:

```json
{"type":"resolved","routeId":"home-messages","effectId":"part-uuid","resolution":"failed"}
```

An accepted send resolution also contains `providerHandle`. Codex admissions permit only `failed`.
Unknown or already resolved identities fail with `effect_not_found`. No retry command exists.

### Gateway configuration contract

| Table | Fields |
| --- | --- |
| `gateway` | Required `listen_port`, `public_url`; optional `state_dir` |
| `gateway.sendblue` | Required `id`; each credential uses `api_key_id`, `api_secret_key`, or `webhook_secret`, or its corresponding `_env` field |
| `gateway.routes` | Required `id`, `sendblue`, `sender`, `sendblue_number`, `agent` |

Set exactly one direct value or environment reference for each credential. Empty values and line breaks are rejected.
Keep configs with direct credentials owner-only (`chmod 600`).

At least one account and route are required. Unknown gateway fields are rejected.
IDs use lowercase slugs that start with a letter. Environment-variable names use letters, digits, and underscores, without an initial digit.

`listen_port` is an integer from 1 to 65535. `public_url` is an HTTPS origin without credentials, a path, query, or fragment.
`state_dir` must be absolute. Its default is `~/.codex-router/gateway`.
Phone numbers contain `+`, a nonzero country-code digit, and 6 to 14 additional digits.

Routes reference existing accounts and agents. Each account/sender/line combination and each route target must be unique.
Pending work prevents changes to its account, numbers, SSH host, task ID, or working directory.

### Gateway HTTP contract

| Endpoint | Result |
| --- | --- |
| `GET /healthz` | 200 with `{"ok":true}` |
| `GET /readyz` | 200 with `{"ready":true}`, or 503 with `{"ready":false}` |
| `POST /webhooks/sendblue/ACCOUNT` | 204 after durable acceptance, deduplication, or intentional ignoring |
| `POST /callbacks/sendblue/ACCOUNT/PART/TOKEN` | 204 after settlement or an ignored callback |

POST requests require `application/json` and the configured `sb-signing-secret` header.
Authentication precedes JSON parsing. POST responses have empty bodies.
Authenticated outbound, group, and unmatched inbound events make no state changes.
A current callback also requires its random token. An authenticated stale callback returns 204.

| Status | Meaning |
| --- | --- |
| 400 | Invalid authenticated JSON or event fields |
| 401 | Missing or incorrect signing secret, or incorrect current callback token |
| 404 | Unknown account or path |
| 405 | Wrong HTTP method |
| 408 | Request body inactivity timeout |
| 413 | Body exceeds 256 KiB |
| 415 | Content type is not JSON |
| 503 | Intake is unavailable or a required durable write failed |

Request headers have a 30-second deadline. Request bodies have a 60-second inactivity deadline.
Send and typing requests have 60-second deadlines. Upload attempts have ten-minute deadlines.
Downloads have separate 60-second header and body-inactivity deadlines. Codex turns have no overall deadline.
Message requests share ten starts per rolling second for each sending number.

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
| `gateway_running` | Another process owns the gateway state lock |
| `effect_not_found` | The requested unresolved effect is absent |
| `state_invalid` | The durable state or a pending route binding is invalid |
| `storage_failed` | The gateway cannot read or write its durable files |
| `input_invalid` | The command arguments or stdin input are invalid |
| `interrupted` | The caller interrupted the turn |
| `output_too_large` | A semantic message exceeded 256 KiB |
| `thread_unavailable` | The configured task could not be resumed |
| `timeout` | A connection, handshake, or control request did not acknowledge in time |
| `turn_failed` | Codex ended the turn without a final response |
| `unknown_agent` | The requested agent ID is absent from the configuration |
| `working_directory_invalid` | The configured working directory is unavailable |

## Exit codes

| Exit code | Meaning |
| --- | --- |
| `0` | Success |
| `1` | Configuration, validation, or runtime failure |
| `2` | Invalid command usage or input |
