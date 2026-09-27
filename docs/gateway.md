# Sendblue gateway

The gateway connects a Sendblue conversation to an existing Codex task. Send text, images, or files from your messaging app. Codex can reply with text and files.

Sendblue adds guidance for short conversational replies, automatic text delivery, and optional attachments. Other connectors can supply their own instructions.
The gateway adds no default instructions. CLI `send` passes input unchanged.

Each conversation has a fixed route. Initial Sendblue messages use the configured batch interval. During an active turn, follow-ups bypass batching and steer that turn through Desktop or the app-server. Sendblue and HTTPS follow-ups share this behavior, including switches between connectors. Participating HTTPS requests retain the shared result. Sendblue receives one shared response when it participates.

## Configure a conversation

Add these tables after your agent entries in `~/.codex-router/config.toml`:

```toml
[gateway]
listen_port = 8787
# Optional. The default is ~/.codex-router/gateway.
state_dir = "/home/user/.codex-router/gateway"

[[gateway.sendblue]]
id = "personal"
mode = "poll" # Default. No public endpoint is required.
api_key_id = "REPLACE_WITH_SENDBLUE_API_KEY_ID"
api_secret_key = "REPLACE_WITH_SENDBLUE_API_SECRET_KEY"

[[gateway.routes]]
id = "home-messages"
sendblue = "personal"
sender = "+15555550100"
sendblue_number = "+15555550200"
agent = "home"
```

Use your registered Sendblue line for `sendblue_number`. Use your own messaging number for `sender`. Both numbers must use E.164 format, including `+` and the country code.

Replace the two credential placeholders with your Sendblue API key and secret. Polling needs no webhook signing secret.
Set owner-only permissions with `chmod 600 ~/.codex-router/config.toml`.

Environment variables remain supported. To use one, replace its direct field with the corresponding `_env` field, such as `api_key_id_env = "SENDBLUE_API_KEY_ID"`.
Set exactly one source for each credential. The router does not load a separate credentials file.

Run the gateway:

```sh
codex-router doctor
codex-router gateway
```

The gateway runs in the foreground and listens on `127.0.0.1`. A service manager can restart the process after failure. Use one process for each state directory.

## Polling and recovery

The gateway checks Sendblue through outbound HTTPS approximately every five seconds. It uses the official SDK. No public tunnel or inbound port is needed for Sendblue.

To reduce response latency, set these account fields:

```toml
poll_interval_ms = 1000
batch_quiet_ms = 1000
```

Both default to 5000 milliseconds. Faster polling uses more API requests. A shorter quiet period can split messages sent a few seconds apart into separate turns. Polling accepts 250–60000 milliseconds; batching accepts 250–30000. Failure backoff and rate limits still apply.

New accounts start from their first activation time. To include earlier messages during migration, set `poll_start` in the account table before the first polling start:

```toml
poll_start = "2026-09-27T06:00:00.000Z"
```

The gateway saves this boundary before requesting messages. Restarts resume the saved checkpoint; changing `poll_start` does not reset it. Existing message receipts prevent duplicate admissions.

Each sweep reads all pages and saves progress only after durable admission. A 24-hour overlap and checkpoint steps of at most 12 hours repair ordinary page changes during catch-up. Recovery beyond 29 days requires an explicit choice. Messages older than the route boundary or 29 days are excluded. Provider offset pagination does not guarantee recovery from arbitrary indexing delays.

Polling reports `idle`, `degraded`, or `blocked` transitions in stderr as `sendblue_poll` records. Provider bodies and credentials are excluded. Readiness reports local gateway startup, not successful polling or delivery.

To choose a new recovery boundary, stop the gateway and run:

```sh
codex-router gateway polling-reset personal 2026-09-27T06:00:00.000Z --json
```

Use a UTC timestamp with milliseconds within the last 29 days. This changes the eligible history boundary and retains existing receipts. Restart the gateway afterward.

## Optional webhook mode

Use `mode = "webhook"` only when a public receiver is wanted. Set `gateway.public_url` and the account's `webhook_secret` or `webhook_secret_env`. Register `<public_url>/webhooks/sendblue/<account-id>` with Sendblue. This mode includes outbound status callback URLs. Poll mode disables both inbound webhook and callback routes.

A proxy can forward HTTPS to the loopback listener in webhook mode. Public exposure is an explicit deployment choice, not a Sendblue requirement. See [Sendblue webhook configuration](https://docs.sendblue.com/getting-started/webhooks/).

For LAN-only HTTPS clients, configure the native TLS listener described in [HTTPS setup](https.md). The listener and Sendblue intake mode are independent.

## Desktop routing

On a local Unix host, the gateway first looks for the Desktop owner of the configured task. If found, it sends through that owner. Otherwise, it uses the existing app-server connection or starts its own server after confirming that no shared endpoint exists. SSH routes resolve on the remote host.

A busy private CLI session may hold the task without an endpoint that the gateway can join. The gateway retains the message and retries after a capped delay. Connection failures do not authorize a second server. Authentication, protocol, configuration, and state errors stop the route with a diagnostic.

Before sending input, the gateway stores the message UUID and execution target. If an acknowledgement is lost, it reads history to find that UUID. It never resends uncertain input. Desktop replies must follow the actual accepted user message; earlier text and images are excluded.

The gateway releases its execution connection after storing the prepared response. It does not retain a private writer while waiting for provider acceptance. Desktop-owned turns keep Desktop's normal tools and permissions.

In webhook mode, for live route status, send an authenticated `GET /statusz` request with the account's `sb-signing-secret` header. The response contains only that account's routes:

```json
{"ready":true,"routes":[{"routeId":"home-messages","state":"retrying","code":"thread_busy"}]}
```

States include `idle`, `running`, `retrying`, `blocked`, and `unresolved`. Readiness describes durable intake, not successful execution or message delivery.

The gateway and CLI `send` and `cancel` use the same owner selection. Desktop-owned chats use Desktop IPC. Interactive CLI clients can share a persistent app-server with the router. The adapter rejects unsupported Desktop protocols and ambiguous history instead of guessing. Already-admitted Desktop work waits for a Desktop owner to return; it does not switch to a private server.

## Files and responses

Inbound images become image inputs. Other attachments become local files available to Codex. The gateway supplies a response directory for intentional output files. It also collects native generated images from the exact turn.

Responses send text first, then files. Upload failures add a filename and omission notice to the text. The gateway freezes the response before the first recipient request. A restart uses the stored text, order, and uploaded URLs.

The gateway rejects symlinks, directories, and files that change during copying. Outside native-image source files remain unchanged. Sendblue uploads have a 100,000,000-byte limit. See the [Sendblue upload contract](https://docs.sendblue.com/api-v2/media/).

Typing starts during batching and renews during useful work. Sendblue firmware support determines whether the indicator appears.

## Recover an uncertain operation

Inspect live status without stopping the gateway:

```sh
codex-router gateway status --json
```

```json
{"unresolved":[{"routeId":"home-messages","effectId":"part-uuid","kind":"send"}],"runtime":{"state":"stopped"}}
```

An unresolved operation blocks its route. Other routes continue. Inspect the provider record or Codex task before choosing a resolution.

Stop the gateway before resolving an operation. For a Sendblue message with a known accepted handle:

```sh
codex-router gateway resolve home-messages part-uuid accepted provider-handle --json
```

For a failed Sendblue message:

```sh
codex-router gateway resolve home-messages part-uuid failed --json
```

For an unresolved Codex admission, only `failed` is available. Use the reported client message ID as `EFFECT_ID`. This resolution prevents another submission and adds a notice to the response. An accepted turn continues to completion.

Restart the gateway after resolution. An accepted send continues with later parts. A failed send skips later parts. The gateway never replays a stored `sending` part automatically.

Live sends permit two retries only after definite retryable rejections, such as a rate-limit rejection. Exhausted rejections fail the part. A lost response, server error, or unusable success response remains unresolved and is never automatically resent. In webhook mode, a positive callback can settle an uncertain part, including after restart.

SIGINT and SIGTERM stop intake and abort local work. Shutdown sends no explicit turn cancellation. Losing an owned stdio app-server can interrupt its turn; recovery does not resend the input. Keep the state directory across restarts. It contains message content and files, with access restricted to its owner.

See [Gateway technical contracts](gateway-contracts.md) for exact state, callback, and recovery rules.

## Validation status

See [current connector verification](connector-verification.md) for SDK polling and LAN TLS results. Earlier webhook tests below are historical evidence.

Automated tests cover provider payloads, durable recovery, callbacks, retries, file transfer, and shutdown. Live checks cover local and SSH Codex connections, file transfers, and the public EXE.dev webhook. The September 26 owner-routing checks also recovered three real Desktop probes, completed a new adapter turn, and delivered the preserved queued reply over RCS. Full Desktop stop/start and Windows qualification remain open. See [owner-routing verification](owner-routing-verification.md).

## HTTPS connector

The gateway also supports an optional [HTTPS connector](https.md). A route can accept Sendblue, HTTPS, or both. Each source receives its own responses; shared routes share agent context, not a synchronized client transcript.

## Local process ownership

The gateway holds an operating-system lock for its lifetime. See [local lock ownership](gateway-lock.md) for details.
