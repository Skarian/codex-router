# SendBlue setup

The SendBlue connector routes messages from one phone number to a configured Codex chat.
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
| Route `id` | A local name you choose, such as `home-messages` |
| Route `agent` | An agent ID from the router configuration |
| Agent `thread_id` | An existing Codex chat ID |

Both phone numbers require E.164 format: `+`, country code, and number.
Account and route IDs are local names. They are not IDs from the SendBlue dashboard.
Polling does not require a webhook secret.

## Configure the route

Create or edit `~/.codex-router/config.toml`.
On Windows, use `%USERPROFILE%\.codex-router\config.toml`.

```toml
[[agents]]
id = "home"
label = "Home Assistant"
cwd = "/absolute/path/to/project"
thread_id = "REPLACE_WITH_EXISTING_CHAT_ID"
model = "REPLACE_WITH_AVAILABLE_MODEL"

[gateway]
listen_port = 8787

[[gateway.sendblue]]
id = "personal"
mode = "poll"
api_key_id = "REPLACE_WITH_SENDBLUE_API_KEY_ID"
api_secret_key = "REPLACE_WITH_SENDBLUE_API_SECRET_KEY"

[[gateway.routes]]
id = "home-messages"
sendblue = "personal"
sender = "+15555550100"
sendblue_number = "+15555550200"
agent = "home"
```

Replace the placeholders and phone numbers. If the agent already exists, add only the gateway tables.
If `[gateway]` already exists, extend it instead of creating a second table.
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
The router limits each SendBlue upload to 100,000,000 bytes.

## Polling recovery

Restarts retain the polling checkpoint and message receipts.
Each sweep reads every page and saves its checkpoint only after durable admission.
Overlapping scans cover 24 hours, with checkpoint advances of at most 12 hours.
Messages older than the route activation boundary or 29 days are excluded.
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
| Message never enters the route | Exact sender and SendBlue numbers, account reference, and activation time |
| Read receipt is slow | Poll interval, provider latency, and polling health |
| Polling is degraded or blocked | Stderr `sendblue_poll` records and API credential validity |
| Gateway is ready but no reply arrives | Route state, Codex authentication, chat ID, and execution owner |
| Route is unresolved | The provider or Codex record before [manual resolution](gateway.md#recover-an-uncertain-operation) |
| Message reaches Codex but an attachment is absent | The omission notice and file upload limit |

Do not delete the state directory to resolve delivery uncertainty. It contains receipts that prevent duplicate submissions.

## Optional webhook mode

Polling is sufficient for ordinary use. Webhooks require an explicitly deployed public HTTPS receiver.
For webhook mode, set `mode = "webhook"`, `gateway.public_url`, and the account's `webhook_secret` or `webhook_secret_env`.
Register `<public_url>/webhooks/sendblue/<account-id>` using [SendBlue webhook configuration](https://docs.sendblue.com/getting-started/webhooks/).

Webhook mode enables inbound handlers and outbound status callbacks. Poll mode disables both.
LAN HTTPS clients are independent of this setting. See [HTTPS setup](https.md).
