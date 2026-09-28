# HTTP API and LAN HTTPS

The optional HTTP connector exposes configured agents through a local API. It supports discovery, durable requests, semantic progress, results, and cancellation.
The router listens only on `127.0.0.1`. An optional external proxy supplies HTTPS and authentication for LAN clients.
CLI operation and SendBlue polling require neither the listener nor the proxy.

## Configuration

Add this table to `~/.codex-router/config.toml`:

```toml
[gateway.http]
port = 8788
```

The port defaults to 8787. Every configured agent becomes available through the API without another route or account table.
Local programs can access the API without credentials. Proxy-authenticated clients share access to all agents, requests, results, and cancellation.
The API does not provide per-client access controls or a synchronized chat transcript.

Start the gateway and inspect its catalog:

```sh
codex-router gateway
```

In another terminal:

```sh
curl http://127.0.0.1:8788/v1/agents
```

The response contains agent IDs and labels. It excludes credentials and filesystem paths.
The backend requires `Host: 127.0.0.1:<port>`. It ignores forwarded headers for authorization and grants no CORS access.
Use the literal loopback address, not `localhost` or a LAN address.

## LAN HTTPS with Caddy

[Caddy](https://caddyserver.com/docs/install) is an optional external program. It manages certificates and authentication without adding them to the router configuration.
Clients still need its public CA certificate. Certificate generation alone cannot establish trust on another device.

The example preserves LAN port 8787 and sends backend traffic to loopback port 8788.
Replace `192.168.1.212` with your Windows PC's reserved LAN address.

Generate a password hash interactively:

```sh
caddy hash-password
```

Save this Caddyfile, with the generated hash in place of `REPLACE_WITH_PASSWORD_HASH`:

```caddyfile
{
    auto_https disable_redirects
    servers {
        protocols h1 h2
    }
}

https://192.168.1.212:8787 {
    bind 192.168.1.212
    tls internal
    basic_auth {
        router REPLACE_WITH_PASSWORD_HASH
    }
    reverse_proxy 127.0.0.1:8788 {
        header_up Host {upstream_hostport}
    }
}
```

Validate and start Caddy:

```sh
caddy validate --config Caddyfile --adapter caddyfile
caddy run --config Caddyfile --adapter caddyfile
```

This recipe opens no HTTP redirect port or HTTP/3 listener. Caddy handles SSE without extra buffering configuration.
The recipe adds no proxy retries. Clients retry uncertain requests with their original UUID and exact payload.
See [Caddy proxy behavior](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy) and [Basic authentication](https://caddyserver.com/docs/caddyfile/directives/basic_auth).

Caddy stores its private CA under its service user's data directory. Keep that user and directory stable across restarts and updates.
For a normal Windows user, the default data directory is `%APPDATA%\Caddy`.
The public root is `pki\authorities\local\root.crt` under that directory.
An `XDG_DATA_HOME` override or different startup identity changes the location. Inspect `caddy environ` when necessary. See [Caddy data directories](https://caddyserver.com/docs/conventions#data-directory).

Copy only `root.crt` to the client through a trusted channel. Keep all private keys on the server.
A client can trust this root for later server certificate renewals under the same CA.
Replacing the CA requires client trust updates. See [Caddy local HTTPS](https://caddyserver.com/docs/automatic-https#local-https).

Verify the proxy from another computer:

```sh
curl --cacert /path/to/root.crt --user router \
  https://192.168.1.212:8787/v1/agents
```

Curl prompts for the password. On Windows, use `curl.exe` to avoid shell aliases.
Do not disable certificate verification or follow redirects with credentials.
Keep the PC awake and reserve its LAN IP. Restrict firewall access to the intended LAN clients.

For automatic startup, run both Caddy and the router under the same Windows user.
An existing Task Scheduler task can start a script that launches both processes and handles their exit status.
A task triggered at sign-in does not provide availability before sign-in.
Test each process restart and both startup orders before relying on unattended operation.
The router does not install or manage a Windows service.

## Submit and retrieve

Create a UUID and save it with the exact prompt before the first attempt.
Use an agent ID from `GET /v1/agents`:

```http
POST /v1/agents/home/requests
Content-Type: application/json

{"request_id":"60fb8888-728b-4e71-953a-b89c3a8f620b","text":"Explain the current project status."}
```

The LAN client also supplies its proxy credentials. The router itself requires no bearer token.
A `202` response confirms durable intake, not completed execution. It includes a relative `result_url`.

```http
GET /v1/agents/home/requests/60fb8888-728b-4e71-953a-b89c3a8f620b
```

Retry a lost POST response with the same UUID and exact text. Matching retries return the existing request.
Changed text with the same UUID returns `409`. Never generate a new UUID merely because an acknowledgement was lost.

Requests report queued, running, unresolved, or terminal state. Diagnostic fields distinguish execution errors from pending delivery.
Terminal output contains status, text, and notices. Empty text stays empty.
HTTP accepts text only. It accepts no attachments, arbitrary URLs, callback addresses, or caller-selected execution configuration.
Unsupported output attachments produce notices.

A follow-up steers the agent's active turn, including a turn started through another connector.
Participating requests receive the shared final response. This API does not synchronize messages submitted through other clients.

## Receive events

```http
GET /v1/agents/home/requests/60fb8888-728b-4e71-953a-b89c3a8f620b/events
Accept: text/event-stream
Last-Event-ID: <last-consumed-frame-id>
```

Events are `status`, `reasoning`, `commentary`, `terminal`, and `reset`.
Reasoning events contain backend-published summaries. Commentary contains completed messages, not draft text or individual tokens.
Backend capability limits still apply. A missing progress capability does not invalidate a final response.

Each encoded SSE frame is at most 4096 bytes. Large semantic messages use multiple transport parts:

```json
{"message_id":"opaque","part":0,"end":false,"field":"text","text":"Part of a completed message"}
```

`field` is `text` or `metadata`. Metadata parts contain serialized JSON.
Assemble each field in part order. The final part has `end: true`.
Save the cursor only after consuming its frame. On reconnect, send that cursor as `Last-Event-ID`.

A `reset` means replay continuity is unavailable. Discard incomplete content in both the parser and its display or storage sink.
Progress history is temporary. Restart or eviction can remove earlier summaries and commentary.
Final results remain available through GET and terminal replay. Replay never starts another turn.

A terminal message ends the stream after its last part. Stop reconnecting after that point.
Heartbeat comments arrive every 15 seconds. Slow clients can lose their stream without stopping execution.

## Cancel a turn

Use the current request's `turn_id` as `expected_turn_id`:

```http
POST /v1/agents/home/cancel
Content-Type: application/json

{"expected_turn_id":"THE_OBSERVED_TURN_ID"}
```

Cancellation affects the shared turn and its participants. It does not remove queued input or resolve provider deliveries.

| Response | Meaning |
| --- | --- |
| `202 interrupt_requested` | Codex acknowledged the request; observe the eventual result |
| `200 already_finished` | The expected turn is finished and no successor is active |
| `409` | Stale turn identity, unresolved admission, or unsupported interruption |
| `503 interrupt_uncertain` | The acknowledgement is unknown; inspect status before another action |

The router never substitutes a newer turn for the supplied ID. A disconnected SSE client does not cancel execution.

## Limits and upgrades

Prompts permit 64 KiB of decoded UTF-8 text. Request bodies permit 512 KiB. Semantic messages permit 256 KiB.
Terminal results remain available for 30 days. `expires_at` gives the deadline in Unix milliseconds.
Do not retry expired requests as new work.

Defaults are 1024 retained requests and an 8 MiB result budget. Reservations can reject intake before the request count reaches its limit.
Capacity rejection returns `429`. Matching duplicate lookups remain available at capacity.
Pending and unresolved requests do not expire automatically.

The semantic replay budget is 2 MiB or 128 messages per request, with 16 MiB globally.
HTTP frame indexes have a separate 2 MiB budget. Stream quotas and write backpressure bound live connections.

For old test configuration or state, use [test installation replacement](gateway.md#replace-a-test-installation).
For the ESP32 client, resolve pending old-format requests before changing the server endpoint or firmware.
See [the ESP-IDF example](../examples/esp32-https/README.md) for trust, credentials, persistent identities, and reconnect behavior.

## Optional provider webhooks

SendBlue polling needs no inbound listener. Webhook deployments use a separate explicitly configured public HTTPS proxy.
The agent API requires edge authentication. SendBlue webhook and callback paths retain their application signing-secret checks.
Do not apply Basic authentication to provider paths that cannot supply it.
See [SendBlue webhook mode](sendblue.md#optional-webhook-mode).
