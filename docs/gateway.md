# Gateway operation and recovery

The optional gateway routes requests to existing Codex chats. It stores accepted input before execution.
CLI commands operate independently and do not require its process or state store.

SendBlue and HTTP are optional connectors. HTTP exposes all configured agents.
SendBlue maps each configured conversation to an agent. Several conversations can select the same agent.
Start with [SendBlue setup](sendblue.md) or [HTTP API and LAN HTTPS](https.md).

## Start and inspect

```sh
codex-router gateway
codex-router gateway status --json
```

Run the status command in another terminal. The gateway runs in the foreground.
An external service manager can start it and restart it after failure.

The default state directory is `~/.codex-router/gateway`. Run one process per state directory on a local filesystem.
Live diagnostics distinguish execution, progress availability, polling, and delivery.
Readiness confirms local startup. It does not prove model execution or provider delivery.
Diagnostics errors do not alter canonical request state.

SendBlue polling uses outbound HTTPS and opens no listener.
`[gateway.http]` enables a listener on `127.0.0.1` only.
For LAN clients, an optional external proxy supplies TLS and authentication.

## Execution and connector behavior

CLI sends, CLI cancellation, and gateway requests share execution-owner discovery.
A local Desktop-owned chat uses Desktop IPC on macOS or Windows.
Otherwise, the router uses an existing app-server or starts a direct server after verified endpoint absence.
SSH agents use a persistent remote app-server.

Idle input starts a turn. Follow-ups steer the active turn, including turns started through another connector.
Participating requests receive the shared final result. Clients do not receive a synchronized transcript of other clients' submissions.

The gateway adds no default agent instructions. SendBlue adds short-reply and attachment guidance.
HTTP and CLI requests add no connector guidance.

The runtime commits each execution intent before sending it to Codex. An uncertain acknowledgement triggers correlation of that same identity.
It never creates a replacement request to retry an uncertain admission.
Recovery of Desktop-admitted work waits for the Desktop owner.

A private CLI session can hold a chat without an endpoint that the router can join.
The gateway waits for ownership instead of opening a competing writer.
Independent `codex exec` ownership remains outside the tested support scope.

Completion and connector delivery are separate. HTTP can retrieve the final result while a SendBlue upload or delivery remains pending.
An uncertain delivery blocks later delivery to that conversation. It does not block the agent's next execution.
Polling capacity can still pause other conversations within the same account.

## State and process ownership

One atomic writer updates state. One operating-system lock prevents competing writers.
A process crash releases the lock. A paused process retains it.
See [local gateway ownership](gateway-lock.md) for platform details.

Keep the state directory across restarts. Requests, deduplication receipts, polling checkpoints, results, and pending deliveries depend on it.
State and referenced files contain private message content. Their access is restricted to the owner.
The current state format is version 3. The gateway rejects incompatible configuration and state.

SIGINT and SIGTERM stop intake and local work without explicit turn cancellation.
Loss of an owned stdio app-server can interrupt its turn. Recovery does not resend uncertain input.

## Recover an uncertain operation

Inspect the running gateway:

```sh
codex-router gateway status --json
```

Find the unresolved admission or delivery and its identifiers. Inspect the Codex or provider record before choosing a resolution.
Stop the gateway before changing canonical recovery state.

The CLI reference describes [manual resolution](cli-reference.md#gateway-commands) and polling reset.
An accepted provider send requires its provider handle. An unconfirmed Codex admission permits only a failed resolution.
Resolution does not automatically replay input or uncertain provider sends.
Restart the gateway after resolution.

Do not delete state to clear uncertainty. Deleting receipts can cause duplicate execution or messages.
The HTTP API exposes no remote recovery-resolution operation.

## Replace a test installation

Version `0.2.0` does not convert state or configuration from earlier test builds.
Existing test installations need a fresh configuration and state directory.

1. Finish or reconcile pending requests in the old installation.
2. Stop the gateway and pause its clients.
3. Move the old state directory aside.
4. Replace the configuration with the current format.
5. Update client endpoints and optional proxy authentication.
6. Start the gateway and test discovery, requests, progress, and results.
7. Resume client traffic after those checks pass.

Fresh state has no previous receipts or polling checkpoints. Replaying old requests can cause duplicate actions.
Retain normal operating state across future restarts. This reset applies only to disposable test installations.
See [ESP32 upgrade guidance](../examples/esp32-https/README.md#upgrade-an-existing-device) for pending device requests.

## Qualification

See [release qualification](release-qualification.md) for recorded tests and platform limits.
Historical results do not certify a new state schema, proxy recipe, or client firmware.
The qualification record separates the current release checks from earlier results.
