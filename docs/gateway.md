# Sendblue gateway

The gateway connects a Sendblue conversation to an existing Codex task. Send text, images, or files from your messaging app. Codex can reply with text and files.

Each conversation has a fixed route. Messages collect until five seconds pass without another message, or the batch reaches 30 seconds. New messages join an active turn. That turn produces one shared response.

## Configure a conversation

Add these tables after your agent entries in `~/.codex-router.toml`:

```toml
[gateway]
listen_port = 8787
public_url = "https://my-gateway.exe.xyz"
# Optional. The default is ~/.codex-router/gateway.
state_dir = "/home/user/.codex-router/gateway"

[[gateway.sendblue]]
id = "personal"
api_key_id_env = "SENDBLUE_API_KEY_ID"
api_secret_key_env = "SENDBLUE_API_SECRET_KEY"
webhook_secret_env = "SENDBLUE_WEBHOOK_SECRET"

[[gateway.routes]]
id = "home-messages"
sendblue = "personal"
sender = "+15555550100"
sendblue_number = "+15555550200"
agent = "home"
```

Use your registered Sendblue line for `sendblue_number`. Use your own messaging number for `sender`. Both numbers must use E.164 format, including `+` and the country code.

Set the three secret variables in the gateway process environment. Store variable names in TOML, never secret values. Use the signing secret configured in your Sendblue account.

Run the gateway:

```sh
codex-router doctor
codex-router gateway
```

The gateway runs in the foreground and listens on `127.0.0.1`. A service manager can restart the process after failure. Use one process for each state directory.

## Expose the webhook on EXE.dev

Run the gateway on the VM that serves `public_url`. Configure the VM proxy from your computer:

```sh
ssh exe.dev share port my-gateway 8787
ssh exe.dev share set-public my-gateway
```

EXE.dev supplies HTTPS and forwards requests to the selected port. Sendblue needs public access because its webhook cannot complete a browser login. See the [EXE.dev proxy documentation](https://exe.dev/docs/proxy).

Set your Sendblue inbound webhook to:

```text
https://my-gateway.exe.xyz/webhooks/sendblue/personal
```

The last path component must match the Sendblue account ID in TOML. Keep the account signing secret enabled. The gateway supplies a separate callback URL with each outbound part. See [Sendblue webhook configuration](https://docs.sendblue.com/getting-started/webhooks/).

Check the endpoints:

```sh
curl --fail https://my-gateway.exe.xyz/healthz
curl --fail https://my-gateway.exe.xyz/readyz
```

`healthz` reports a listening server. `readyz` reports completed local recovery and available intake. An unavailable Codex host or unresolved send does not change global readiness.

## Files and responses

Inbound images become image inputs. Other attachments become local files available to Codex. The gateway supplies a response directory for intentional output files. It also collects native generated images from the exact turn.

Responses send text first, then files. Upload failures add a filename and omission notice to the text. The gateway freezes the response before the first recipient request. A restart uses the stored text, order, and uploaded URLs.

The gateway rejects symlinks, directories, and files that change during copying. Outside native-image source files remain unchanged. Sendblue uploads have a 100,000,000-byte limit. See the [Sendblue upload contract](https://docs.sendblue.com/api-v2/media/).

Typing starts during batching and renews during useful work. Sendblue firmware support determines whether the indicator appears.

## Recover an uncertain operation

Stop the gateway before inspecting or resolving state:

```sh
codex-router gateway status --json
```

```json
{"unresolved":[{"routeId":"home-messages","effectId":"part-uuid","kind":"send"}]}
```

An unresolved operation blocks its route. Other routes continue. Inspect the provider record or Codex task before choosing a resolution.

For a Sendblue message with a known accepted handle:

```sh
codex-router gateway resolve home-messages part-uuid accepted provider-handle --json
```

For a failed Sendblue message:

```sh
codex-router gateway resolve home-messages part-uuid failed --json
```

For an unresolved Codex admission, only `failed` is available. Use the reported client message ID as `EFFECT_ID`. This resolution prevents another submission and adds a notice to the response. An accepted turn continues to completion.

Restart the gateway after resolution. An accepted send continues with later parts. A failed send skips later parts. The gateway never replays a stored `sending` part automatically.

Live requests permit two retries after eligible failures. A lost response can cause duplicate delivery during those retries. A later rejection cannot erase earlier uncertainty. A positive callback can settle an uncertain part, including after restart.

SIGINT and SIGTERM stop intake and abort local work. Shutdown does not interrupt the Codex turn. Keep the state directory across restarts. It contains message content and files, with access restricted to its owner.

See [Gateway technical contracts](gateway-contracts.md) for exact state, callback, and recovery rules.

## Validation status

Automated tests cover provider payloads, durable recovery, callbacks, retries, file transfer, and shutdown. Live checks cover local and SSH Codex connections, file transfers, and the public EXE.dev webhook. Real Sendblue delivery validation remains required before release.
