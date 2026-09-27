# HTTPS connector

The gateway accepts text requests through HTTPS and returns completed commentary through SSE. Each request has a durable final result.

Sendblue and HTTPS can share a configured Codex chat. Each source receives its own replies. The agent shares conversation context; clients do not receive a synchronized transcript or messages submitted elsewhere.

## Configuration

Add an HTTPS account and bind it to a route in `~/.codex-router/config.toml`:

```toml
[gateway]
listen_port = 8787
listen_host = "192.168.1.50"
state_dir = "/absolute/path/to/gateway-state"

[gateway.tls]
cert = "/absolute/path/to/server.crt"
key = "/absolute/path/to/server.key"

[[gateway.https]]
id = "device"
bearer_token_env = "CODEX_ROUTER_HTTPS_TOKEN"

[[gateway.routes]]
id = "assistant"
agent = "assistant"
https = "device"
```

The agent must already exist in the configuration. Use either `bearer_token` or `bearer_token_env`, never both. Protect direct tokens with owner-only file permissions. Each account needs a distinct token.

To share a Sendblue route, add `https = "device"` to that route. Keep its existing Sendblue fields. HTTPS-only configurations need neither Sendblue credentials nor `public_url`.

Replace `192.168.1.50` with the gateway computer's private IPv4 address. Reserve that address in your DHCP configuration so clients retain a stable destination.

The gateway serves HTTPS directly when `gateway.tls` contains certificate and key paths. Both paths must be absolute. The certificate must cover the URL's hostname or IP address in its Subject Alternative Name. Keep the private key on the gateway computer with owner-only permissions.

Clients must trust the certificate issuer. For a private CA, copy its **certificate** to each client through a trusted channel. Keep the CA private key off clients. The ESP32 example can embed the CA certificate, as described below.

Without `listen_host`, the listener binds to `127.0.0.1`. Loopback permits HTTP for local tools. A nonloopback listener requires TLS and a specific private IPv4 address. Wildcard and public addresses are rejected. A tunnel or proxy is not required for LAN access.

Binding selects a network interface; it does not replace a firewall. Permit access only from your intended LAN clients. Do not forward the port from your internet router. Sendblue polling uses outbound connections and does not need this listener to be publicly reachable.

Verify the certificate and endpoint from a LAN client:

```sh
curl --cacert /path/to/ca.crt https://192.168.1.50:8787/readyz
```

Do not use `--insecure` or disable certificate verification. Requests and SSE use the same trusted HTTPS connection.

## Submit and retrieve

Create a UUID before sending a request. Save it with the exact prompt before the first attempt.

```http
POST /v1/routes/assistant/requests
Authorization: Bearer <token>
Content-Type: application/json

{"request_id":"60fb8888-728b-4e71-953a-b89c3a8f620b","text":"Explain the current project status."}
```

A `202` response confirms durable admission to the queue. It does not confirm that Codex has started work. The response includes a relative `result_url`.

```http
GET /v1/routes/assistant/requests/60fb8888-728b-4e71-953a-b89c3a8f620b
Authorization: Bearer <token>
```

Retry a lost POST response with the same UUID and exact text. Matching retries return the existing request. Changed text with the same UUID returns `409`.

Possible states are `queued`, `running`, `unresolved`, `completed`, `failed`, and `interrupted`. A `processing` field reports blocked or retrying work. A `blocked_by: "delivery"` field identifies an earlier outbound delivery that holds the shared queue.

Terminal results contain `status`, `text`, and `notices`. Empty text stays empty. Attachment output is not uploaded by HTTPS; supported omission notices identify excluded native images. HTTPS accepts no input attachments, arbitrary URLs, callback addresses, or caller-selected execution settings.

All reads require the account token. Unknown or inaccessible routes and requests return `404`. Token rotation preserves ownership because ownership uses the configured account ID.

## Receive events

```http
GET /v1/routes/assistant/requests/60fb8888-728b-4e71-953a-b89c3a8f620b/events
Authorization: Bearer <token>
Accept: text/event-stream
Last-Event-ID: <last-consumed-frame-id>
```

Events are `status`, `commentary`, `terminal`, and `reset`. Commentary represents a completed message, not tokens or draft text. Terminal output is published only after its result is durable.

Each encoded SSE frame is at most 4096 bytes. Large completed messages use multiple transport parts:

```json
{"message_id":"opaque","part":0,"end":false,"field":"text","text":"A piece of a completed message"}
```

`field` is `text` or `metadata`. Metadata parts contain serialized JSON. Assemble each field in part order. The final part has `end: true`. These parts belong to one logical message; they are not separate agent messages.

Save the SSE cursor only after consuming its frame. On reconnect, send it as `Last-Event-ID`. A `reset` means replay continuity is unavailable. Discard incomplete message content in both the parser and its display or storage sink.

Progress history is temporary and bounded. Restart or eviction can lose earlier commentary. Final results remain available through GET and terminal replay. Neither reconnect nor replay starts another Codex turn.

A terminal message ends the stream after its last part. Stop reconnecting at that point. Heartbeat comments arrive every 15 seconds. Slow clients can lose their stream; execution continues independently.

## Limits and recovery

Prompts are limited to 64 KiB of decoded UTF-8 text. HTTP bodies are limited to 512 KiB. Semantic output messages are limited to 256 KiB.

Terminal results and request identities remain available for 30 days. The response includes `expires_at` in Unix milliseconds. Do not retry an old request as new work after this guarantee expires.

Defaults are 1024 retained requests and a 8 MiB retained-record budget. Configure these with `max_requests` and `retained_bytes`. Pending requests reserve room for their largest permitted result, so the byte limit can reject admission before the count limit.

Capacity rejection returns `429`. Existing duplicate lookups remain available at capacity. Pending and unresolved work never expires automatically. These limits do not bound Sendblue records or the entire process heap.

SSE permits 32 streams globally and four per account. The replay budget is 2 MiB or 128 messages per request, with a 16 MiB global limit.

A route processes one active turn. HTTPS follow-ups steer that turn without waiting for its response. This also applies when Sendblue or another client started the turn. Each participating HTTPS request retains the shared final response. Commentary after admission streams to each participating HTTPS request. Other Desktop or CLI users can also steer the shared conversation.

## Desktop commentary

Desktop commentary requires both an ordered snapshot after the admitted input and a matching persisted completion record. The reader supports paginated rollout history. It has bounded scans and fails closed for commentary if the record is unavailable or invalid.

A running request can report `commentary.state` and its limitation reason. Commentary observation failure does not fail an otherwise valid final response. Direct and SSH sessions use native completed-item notifications.

The macOS live probe passed before release qualification. Windows Desktop and unsupported history modes are not covered by that probe. A known silent disconnect after daemon termination remains a separate transport limitation.

## ESP32 example

See [the ESP-IDF example](../examples/esp32-https/README.md) for bounded parsing, TLS, durable UUID storage, and reconnect behavior. Host parser tests do not replace firmware compilation or device testing.
