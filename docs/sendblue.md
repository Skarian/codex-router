# SendBlue setup

The SendBlue connector maps configured conversations to existing Codex chats.
It accepts text, images, and files. Replies can contain text and attachments.

The default mode polls SendBlue through outbound HTTPS. No public tunnel, webhook, or inbound internet access is required.
The router uses the official SendBlue SDK. You do not need the separate SendBlue CLI.

## Get the account details

Complete the [SendBlue account setup](https://docs.sendblue.com/getting-started/quickstart/) and activate a messaging line.

Open [API settings](https://dashboard.sendblue.com/settings/api) in the SendBlue dashboard.
Copy the API key ID and API secret key into the router configuration.

Open [phone line management](https://dashboard.sendblue.com/settings/phone-line-management) to find the assigned line number.

| Router field | Value |
| --- | --- |
| `api_key_id` | SendBlue API key ID |
| `api_secret_key` | SendBlue API secret key |
| `sender` | Your phone number, from which you send messages |
| `sendblue_number` | The SendBlue line that receives those messages |
| Account `id` | A local name you choose, such as `personal` |
| Conversation `agent` | An agent ID from the router configuration |
| Agent `thread_id` | An existing Codex chat ID |

Both phone numbers require E.164 format: `+`, country code, and number.
Account IDs are local names, not IDs from the SendBlue dashboard.
Each conversation selects an agent through its sender and receiving line.
Polling does not require a webhook secret.

## Configure a conversation

Create or edit `~/.codex-router/config.toml`.
On Windows, use `%USERPROFILE%\.codex-router\config.toml`.

```toml
[[agents]]
id = "home"
label = "Home Assistant"
cwd = "/absolute/path/to/project"
thread_id = "REPLACE_WITH_EXISTING_CHAT_ID"
model = "REPLACE_WITH_AVAILABLE_MODEL"

[[gateway.sendblue]]
id = "personal"
mode = "poll"
api_key_id = "REPLACE_WITH_SENDBLUE_API_KEY_ID"
api_secret_key = "REPLACE_WITH_SENDBLUE_API_SECRET_KEY"

[[gateway.sendblue.conversations]]
sender = "+15555550100"
sendblue_number = "+15555550200"
agent = "home"
```

Replace the placeholders and phone numbers. If the agent already exists, add only the gateway tables.
Add each conversation directly beneath its corresponding `[[gateway.sendblue]]` account.
Multiple conversations can select one agent. Each account, sender, and line combination must be unique.
For Windows paths, use a TOML literal string such as `cwd = 'C:\projects\home'`.

Keep credentials directly in this configuration file. On macOS or Linux, restrict its permissions:

```sh
chmod 600 ~/.codex-router/config.toml
```

On Windows, restrict file access to your account and required system administrators through the file security settings.
Keep the configuration outside the repository.

For environment-based credentials, replace the direct fields with `api_key_id_env` and `api_secret_key_env`.
Their values are environment variable names. Set exactly one source for each credential.
The router does not read a separate credentials file.

## Start and send a message

Inspect the agent list and diagnostics:

```sh
codex-router agents list
codex-router doctor
```

`doctor` checks credential presence, not provider authentication. It checks the CLI/app-server path, not the complete Desktop path.

Start the gateway:

```sh
codex-router gateway
```

Keep that terminal open. From the configured `sender`, text the configured `sendblue_number` after startup.
New polling accounts start at their first activation time. Earlier messages are not imported by default.

In a second terminal, inspect status:

```sh
codex-router gateway status --json
```

`runtime.ready` reports local readiness. A recent `runtime.polling[].lastSuccessAt` shows a successful provider sweep.
`degraded` or `blocked` polling states require attention even when the gateway is ready.

## Timing, read receipts, and files

Polling and initial-message batching each default to 5000 milliseconds.
To reduce both delays, add these fields to the SendBlue account table:

```toml
poll_interval_ms = 1000
batch_quiet_ms = 1000
```

Polling accepts 250–60000 milliseconds. Batching accepts 250–30000 milliseconds.
Faster polling uses more API requests. Shorter batching can split closely spaced messages into separate turns.
During an active turn, follow-ups bypass batching and steer that turn after intake.

The gateway requests a read receipt after it stores the inbound message.
Polling delay and provider latency occur before the receipt appears.
Typing and read receipts are best effort. Their failures do not stop the reply.

SendBlue adds agent guidance for short replies and output attachments. The CLI adds no connector instructions.
Images become image inputs. Other attachments become files available to Codex.
Replies send text before files. Upload failures produce omission notices.
A completion permits at most 16 files and 100,000,000 bytes in total.
Staging has a 60-second deadline and a shared 512 MiB spool limit. Excess files produce omission notices.
Provider uploads and delivery follow durable model completion. A blocked delivery does not stop HTTP results or later execution.
Deliveries retain order within each conversation.

## Polling recovery

Restarts retain the polling checkpoint and message receipts.
An exhausted delivery budget rejects new intake before admission. The account checkpoint does not advance past that message.
This can pause other conversations in the same polling account. HTTP clients remain independent.
Each sweep reads every page and saves its checkpoint only after durable admission.
Overlapping scans cover 24 hours, with checkpoint advances of at most 12 hours.
Messages older than the conversation activation boundary or 29 days are excluded.
These bounds do not guarantee recovery from arbitrary provider indexing delays.

To include earlier messages on first startup, add an account field such as:

```toml
poll_start = "2026-09-27T06:00:00.000Z"
```

Choose a recent timestamp within the supported recovery window.
Changing this field after activation does not reset the saved checkpoint.

For an existing account, stop the gateway before choosing a new boundary:

```sh
codex-router gateway polling-reset personal 2026-09-27T06:00:00.000Z --json
```

Use a UTC timestamp with milliseconds within the last 29 days. Restart the gateway afterward.
This operation retains existing receipts. A checkpoint gap beyond 29 days requires this explicit recovery choice.

## Troubleshooting

| Symptom | Inspect |
| --- | --- |
| Message never enters the gateway | Exact sender and SendBlue numbers, selected agent, and activation time |
| Read receipt is slow | Poll interval, provider latency, and polling health |
| Polling is degraded or blocked | Stderr `sendblue_poll` records and API credential validity |
| Gateway is ready but no reply arrives | Agent state, delivery state, Codex authentication, and chat ID |
| Admission or delivery is unresolved | The provider or Codex record before [manual resolution](gateway.md#recover-an-uncertain-operation) |
| Message reaches Codex but an attachment is absent | The omission notice and file upload limit |

Do not delete the state directory to resolve delivery uncertainty. It contains receipts that prevent duplicate submissions.

## Optional webhook mode

Polling is sufficient for ordinary use. Webhooks require an explicitly deployed public HTTPS receiver.
For webhook mode, configure the account and an optional webhook-only listener:

```toml
[gateway.http]
port = 8788
api = false

[[gateway.sendblue]]
id = "personal"
mode = "webhook"
public_url = "https://messages.example.com"
api_key_id = "REPLACE_WITH_SENDBLUE_API_KEY_ID"
api_secret_key = "REPLACE_WITH_SENDBLUE_API_SECRET_KEY"
webhook_secret = "REPLACE_WITH_SIGNING_SECRET"

[[gateway.sendblue.conversations]]
sender = "+15555550100"
sendblue_number = "+15555550200"
agent = "home"
```

`public_url` belongs to this account. It must be an HTTPS origin without a path, query, or credentials.
Register `<public_url>/webhooks/sendblue/<account-id>` through [SendBlue webhook configuration](https://docs.sendblue.com/getting-started/webhooks/).
The account accepts exactly one of `webhook_secret` and `webhook_secret_env`.

The external proxy terminates TLS and forwards to `127.0.0.1:8788` with the matching backend Host header.
For Caddy, use `header_up Host {upstream_hostport}`.
Forward `/webhooks/sendblue/personal` and `/callbacks/sendblue/personal/*` to the backend.
These paths require the SendBlue signing secret. They must not require Basic authentication from the provider.
If `api = true`, separately protect `/v1/*` with edge authentication. Do not expose that API through an unauthenticated provider path.

Webhook mode enables inbound handlers and outbound callbacks. Polling mode disables both for that account.
The [HTTP API and LAN HTTPS](https.md) remain optional and independent of polling.
