# Gateway operation and recovery

The gateway routes messages to existing Codex chats and saves accepted input before execution.
SendBlue and HTTPS are optional connectors. A route can use either connector or both.

Start with [SendBlue setup](sendblue.md) or [HTTPS setup](https.md).
The [CLI reference](cli-reference.md) lists configuration fields and administrative commands.

## Start and inspect

```sh
codex-router gateway
```

The gateway runs in the foreground. A service manager can restart it after failure.
Run one process per state directory. The default directory is `~/.codex-router/gateway`.
Use a local filesystem for state, not a shared network filesystem.

```sh
codex-router gateway status --json
```

Live diagnostics report readiness, polling health, and route states.
Readiness describes local startup. It does not prove successful model execution or provider delivery.
Diagnostics failures do not change canonical message state.

By default, the listener binds to `127.0.0.1`.
SendBlue polling uses outbound HTTPS only. LAN clients require the [HTTPS listener configuration](https.md#configuration).

## Execution and connector behavior

CLI `send`, CLI `cancel`, and gateway requests use the same execution-owner selection.
On macOS and Windows, a local Desktop-owned chat uses Desktop IPC.
Otherwise, the router uses an existing app-server or starts a direct server after confirming endpoint absence.
SSH routes use a persistent remote app-server.

An idle chat starts a turn. Follow-up messages steer an active turn, including messages from another connector on the same route.
Participating HTTPS requests retain the shared result. SendBlue receives one shared response when it participates.
The connectors share Codex context, not a synchronized client transcript.

The gateway adds no default agent instructions. Each connector can supply its own guidance.
SendBlue supplies short-reply and attachment guidance. HTTPS and CLI input have no such guidance.

Before admission, the gateway stores the client message UUID and execution binding.
If an acknowledgement is lost, recovery looks for that UUID. It does not resend uncertain input.
Recovery of Desktop-admitted work waits for Desktop ownership instead of switching to a private server.

A private CLI session can hold a chat without an endpoint that the router can join.
The route then waits for ownership to become available. Independent `codex exec` ownership is outside the tested support scope.

## State and process ownership

The gateway uses one atomic snapshot writer and one operating-system lock.
A process crash releases the lock. A paused process retains it.
The permanent `lock` file and adjacent `owner.json` support ownership and diagnostics.
See [local gateway ownership](gateway-lock.md) for platform details.

Keep the state directory across restarts. Pending admissions, polling checkpoints, results, and provider receipts depend on it.
The current schema requires source identities and receipt records. Version-1 state is unsupported.

## Recover an uncertain operation

Inspect live status without stopping the gateway:

```sh
codex-router gateway status --json
```

```json
{"unresolved":[{"routeId":"home-messages","effectId":"part-uuid","kind":"send"}],"runtime":{"state":"stopped"}}
```

An unresolved operation blocks its route. Other routes continue. Inspect the provider record or Codex task before choosing a resolution.

Stop the gateway before resolving an operation. For a SendBlue message with a known accepted handle:

```sh
codex-router gateway resolve home-messages part-uuid accepted provider-handle --json
```

For a failed SendBlue message:

```sh
codex-router gateway resolve home-messages part-uuid failed --json
```

For an unresolved Codex admission, only `failed` is available. Use the reported client message ID as `EFFECT_ID`. This resolution prevents another submission and adds a notice to the response. An accepted turn continues to completion.

Restart the gateway after resolution. An accepted send continues with later parts. A failed send skips later parts. The gateway never replays a stored `sending` part automatically.

Live sends permit two retries only after definite retryable rejections, such as a rate-limit rejection. Exhausted rejections fail the part. A lost response, server error, or unusable success response remains unresolved and is never automatically resent. In webhook mode, a positive callback can settle an uncertain part, including after restart.

SIGINT and SIGTERM stop intake and abort local work. Shutdown sends no explicit turn cancellation. Losing an owned stdio app-server can interrupt its turn; recovery does not resend the input. Keep the state directory across restarts. It contains message content and files, with access restricted to its owner.

See [Gateway technical contracts](gateway-contracts.md) for exact state, callback, and recovery rules.

## Qualification

See [release qualification](release-qualification.md) for platform tests, live probes, and limits.
The qualification record distinguishes current automated checks from earlier provider and cross-platform probes.
