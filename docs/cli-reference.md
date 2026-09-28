# CLI reference

## Usage

```text
codex-router [--config PATH] agents list [--json]
codex-router [--config PATH] doctor [--json]
codex-router [--config PATH] send AGENT_ID --stdin [--json | --stream]
codex-router [--config PATH] cancel AGENT_ID [--json]
codex-router [--config PATH] gateway
codex-router [--config PATH] gateway status [--json]
codex-router [--config PATH] gateway polling-reset ACCOUNT_ID SINCE_UTC [--json]
codex-router [--config PATH] gateway resolve AGENT_ID EFFECT_ID failed [--json]
codex-router [--config PATH] gateway resolve AGENT_ID EFFECT_ID accepted HANDLE [--json]
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

Durable startup requires a Codex version that supports `codex app-server daemon start`.
The router checks command support, not the installation directory.
The router does not install or update Codex, enable remote control, or restart an existing app-server.
It does not stop the daemon that it starts.
Daemon startup does not make the host available from signed-in mobile devices.

To install or update Codex on an SSH target, you can use the official installer:

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
whether the CLI supports daemon startup. Doctor does not start the daemon or check the task in that case.
The first `send` attempts startup. Command support does not guarantee startup success.

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

Local requests first discover the Desktop owner on macOS or Windows.
If Desktop owns the chat, requests use that connection.
Otherwise, the router connects to an existing app-server endpoint or starts an owned stdio server after confirming endpoint absence.
An unsafe or unreachable endpoint does not authorize a fallback server.

SSH agents start or reuse the persistent Codex daemon and connect through its proxy.
See [gateway execution](gateway.md#execution-and-connector-behavior) for shared ownership and recovery behavior.

## Gateway commands

See [Gateway setup and recovery](gateway.md) for the ordinary message flow and deployment steps.

`gateway` runs in the foreground. It does not accept `--json`, `--stream`, or `--stdin`.
Direct credentials are read from TOML. Environment references are resolved at gateway startup.
Other commands validate the gateway tables without resolving environment references.
Doctor reports whether credentials are present, without contacting SendBlue or printing their values.

`gateway status` works while the service runs and never acquires the state lock. It reads a private status snapshot.
The snapshot refreshes every five seconds. After 15 seconds without an update, status reports `stale`.
Missing, invalid, or mismatched live snapshots report `unavailable`. Both conditions return exit code 1.
`gateway resolve` still requires a stopped service and acquires the state lock.

Status reports unresolved admissions and deliveries separately from runtime readiness.
Inspect the affected agent and effect identifiers before choosing a resolution.
Live diagnostics include polling errors, retry times, execution activity, and delivery blockage.
Stopped status reads unresolved effects from canonical state without changing it.

For a failed effect, use the configured agent ID and reported effect ID:

```sh
codex-router gateway resolve home EFFECT_ID failed --json
```

For a provider-confirmed send:

```sh
codex-router gateway resolve home EFFECT_ID accepted PROVIDER_HANDLE --json
```

An accepted send resolution records its provider handle. Codex admissions permit only `failed`.
Unknown or already resolved identities fail with `effect_not_found`. No retry command exists.

### Gateway configuration contract

| Table | Fields |
| --- | --- |
| `gateway` | Optional `state_dir`, `max_requests`, and `retained_bytes` |
| `gateway.http` | Optional `port` (default 8787) and `api` (default true) |
| `gateway.sendblue` | Required `id`, API credentials, and conversation mappings; optional polling fields |
| `gateway.sendblue.conversations` | Required `sender`, `sendblue_number`, and `agent` |

The presence of `[gateway.http]` enables the loopback listener. Without that table, polling-only gateways open no listener.
`port` accepts 1–65535. The listener binds only to `127.0.0.1`.
`api = false` permits a webhook-only listener without agent API access.
There are no native TLS, HTTP credential, LAN bind, or top-level route fields.

`state_dir` must be absolute. Its default is `~/.codex-router/gateway`.
Each SendBlue conversation references an existing agent. Several conversations can select the same agent.
The account, sender, and receiving line tuple must be unique.
Pending work retains its original target and destination.

For webhook mode, `public_url` belongs to the SendBlue account. It must be an HTTPS origin without credentials, path, query, or fragment.
Set exactly one direct value or environment reference for each provider credential. Unknown fields are rejected.
See [SendBlue setup](sendblue.md) and [HTTP API](https.md) for examples.

`gateway polling-reset` requires a stopped service. It changes a SendBlue recovery boundary while retaining receipts.
See [polling recovery](sendblue.md#polling-recovery) for timestamp requirements.

### Gateway HTTP contract

| Endpoint | Result |
| --- | --- |
| `GET /healthz` | 200 with `{"ok":true}` |
| `GET /readyz` | 200 with `{"ready":true}`, or 503 with `{"ready":false}` |
| `POST /webhooks/sendblue/ACCOUNT` | 204 after durable acceptance, deduplication, or intentional ignoring |
| `POST /callbacks/sendblue/ACCOUNT/PART/TOKEN` | 204 after settlement or an ignored callback |

The SendBlue webhook and callback endpoints exist only in webhook mode.
Those POST requests require `application/json` and the configured `sb-signing-secret` header.
See [HTTP requests and SSE](https.md) for the optional agent API.
External proxies authenticate LAN API clients. The backend validates the exact loopback Host header.
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
| `state_invalid` | The durable state or a pending execution binding is invalid |
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
