# Shared gateway and HTTPS connector plan

## Outcome

Sendblue becomes optional. The gateway supports Sendblue alone, HTTPS alone, or both on the same configured Codex conversation.

One logical route owns one conversation and one execution queue. Connector bindings identify permitted input sources and response destinations.

The CLI continues to use execution sessions directly. This change adds no plugin registry, event bus, second database, or second execution scheduler.

Status: the implementation and local verification are complete. The macOS Desktop completion probe passed with two commentary messages before terminal completion. Transport and release qualification remain separate gates.

This document records the accepted scope. See https.md for the implemented API and connector-verification.md for verification results and remaining limits.

## Scope

The first HTTPS connector accepts text, streams commentary through SSE, and stores terminal results for authenticated retrieval. It does not accept files, arbitrary URLs, callback destinations, or caller-selected execution parameters.

The client cannot choose an unconfigured thread, directory, model, or SSH host. The configured route supplies those values.

HTTPS adds no agent instructions by default. Sendblue retains its instructions, attachments, text formatting, typing indicators, and read receipts.

TLS remains at the existing reverse proxy or tunnel. The gateway retains its loopback listener. HTTPS-only configuration does not require a Sendblue account or public callback origin.

## Configuration

Existing Sendblue configuration remains valid without edits. A new HTTPS account has a stable ID and one bearer token or environment reference.

Example additions to an existing configuration:

```toml
[[gateway.https]]
id = "tools"
bearer_token_env = "CODEX_ROUTER_HTTPS_TOKEN"

[[gateway.routes]]
id = "assistant"
agent = "assistant"
https = "tools"
sendblue = "personal"
sender = "+15555550100"
sendblue_number = "+15555550200"
```

This example defines one route with two sources. HTTPS-only routes omit all Sendblue fields. Sendblue-only routes remain unchanged.

Configuration normalizes each source into a tagged binding. The first version allows one Sendblue binding and one HTTPS binding per route.

The HTTPS account ID identifies the API principal. Token rotation does not change request ownership. A token permits access only to routes bound to its account.

Validation rejects duplicate configured execution targets across logical routes. The target key uses the configured host and thread ID. SSH aliases cannot be canonicalized reliably during parsing.

## Ownership

| Component | Responsibility |
| --- | --- |
| Gateway | Shared queue, admission identity, execution binding, recovery, and atomic result persistence |
| Sendblue adapter | Webhook authentication, message decoding, callbacks, presence, provider rate limits, upload limits, and reply formatting |
| HTTPS adapter | Bearer authentication, request validation, duplicate detection contract, and result retrieval |
| File helpers | Existing safe copy, path validation, and cleanup operations |
| Execution sessions | Existing Desktop, local app-server, and SSH selection and recovery |

HTTP polling does not use fake provider handles, callback tokens, uploads, or send acknowledgments. Its result becomes available through a local state transaction.

The refactor moves Sendblue policy out of shared code. It does not redesign the existing file-transfer implementation or introduce a general artifact service.

## Common connector contract

The gateway has one normalized lifecycle. It does not contain execution branches named Sendblue or HTTPS.

| Common concept | Required information |
| --- | --- |
| Submission | Source identity, external message ID, payload fingerprint, normalized input |
| Source policy | Immediate or timed batching, duplicate behavior, result retention |
| Completed commentary | Execution identity, native item identity, complete immutable text |
| Terminal result | Actual outcome, text, bounded structured notices |
| Completion plan | Retained result or prepared outbound delivery |
| Submission receipt | Durable identity, state, execution reference, optional retained result and expiration |

Source bindings hold immutable recipient and authenticated-principal identity. Normalized input contains no phone numbers, bearer tokens, callback URLs, or provider event objects.

A source adapter supplies policy and completion preparation. Instructions and presence hooks are optional. Only outbound adapters implement provider delivery.

The core branches on retain or deliver lifecycle behavior. It never creates a fake provider handle, upload, or callback for a retained result.

Sendblue normalizes authenticated webhooks and prepares outbound messages. HTTPS normalizes authenticated submissions and exposes gateway read/watch operations.

A static composition root creates the two adapters. Configuration and adapter-owned wire handlers know provider names; shared scheduling and execution do not.

Adapters return validated completion plans. They cannot execute arbitrary state transactions or create a separate request state machine.

Presence hooks remain best effort. Rate limits, callback URLs, uploads, and text chunking belong to the outbound adapter.

A generic receipt supports both connectors. Legacy Sendblue deduplication receipts can lack payload hashes or terminal results; migration does not invent missing data.

Duplicate policy preserves Sendblue's existing first-receipt behavior. HTTPS requires exact-payload identity. Both policies use the same atomic enqueue boundary.

Each participating source retains its response destination. A retained result and an outbound delivery use the same admission and recovery machinery.

## Queue rules

Each durable batch records its source binding and response destination. Active work and Sendblue delivery preserve that identity.

Duplicate detection runs before any queue mutation. A repeated webhook or HTTP request cannot flush a pending batch or alter queue order.

Sendblue retains its current quiet-period batching. Only consecutive initial input from the same Sendblue binding can share a batch. Active-turn follow-ups bypass batching.

An HTTP request immediately creates one queued batch. Before that insertion, the same transaction closes any earlier open Sendblue batch.

Later Sendblue and HTTPS input steers the active turn in admission order. Connector changes do not create an execution barrier.

HTTP input steers existing active work. Follow-ups bypass Sendblue batching. Different routes can still run concurrently.

Every submission has a generic durable receipt. HTTPS retains its terminal result; Sendblue retains duplicate-detection and delivery metadata. Each joined batch keeps its own source binding.

An unresolved Sendblue delivery continues to block its logical route. This preserves existing behavior without adding a separate delivery queue.

A queued HTTP response identifies that route blockage separately from uncertainty about its own Codex admission. Other routes remain available.

## HTTP contract

```http
POST /v1/routes/assistant/requests
Authorization: Bearer <token>
Content-Type: application/json

{"request_id":"<caller-generated UUID>","text":"Explain the current project status."}
```

The caller generates a request ID before its first attempt. The same ID identifies the request in subsequent retries and result retrieval.

The gateway atomically records the request identity, canonical payload hash, and queued batch. It returns `202` only after durable persistence.

The response contains the request ID, current status, and relative result URL:

```http
GET /v1/routes/assistant/requests/<request_id>
Authorization: Bearer <token>
```

Request identity includes HTTPS account ID, route ID, and caller request ID. The payload hash uses a versioned representation of the exact validated text. It does not trim text or normalize Unicode. Unknown fields are rejected.

A repeated ID with the same payload returns the existing request. A repeated ID with different content returns `409`. Neither case adds work.

Every result request authenticates and checks its account and route binding. Request IDs are not access credentials. Unknown or inaccessible request IDs return `404`.

Malformed input returns `400`; invalid authentication returns `401`; oversized input returns `413`. Requests above the capacity limit return `429` before insertion.

States distinguish `queued`, `running`, `unresolved`, `completed`, `failed`, and `interrupted`. A route blockage is additional status information.

Terminal results preserve the actual Codex outcome and text. Empty text remains empty. API failures use stable error codes instead of messaging-specific fallback sentences.

Input attachments are rejected. Generated attachments produce a structured omission notice. Responses do not expose local file paths or invoke Sendblue uploads.

Use the existing 64 KiB prompt limit and 256 KiB semantic-output limit. Use a 512 KiB HTTP body limit to allow JSON escaping while enforcing the decoded prompt limit.

Keep terminal results and their duplicate-detection records for 30 days. Return the terminal expiration time. The retry guarantee applies only within that retention period.

Pending, running, and unresolved requests do not expire automatically. Use a configurable `max_requests` limit, initially 1024 retained-result receipts across retained sources. Existing Sendblue deduplication receipts do not consume this capacity. Duplicate lookups remain available when capacity is full.

Retained sources also share a 8 MiB encoded-record budget. Admission reserves actual stored input plus worst-case terminal text and a bounded metadata allowance.

The terminal reservation allows six encoded bytes per permitted text byte, plus 16 KiB for bounded notices and metadata. Completion replaces the reservation with actual stored size.

Duplicate lookup, byte reservation, count checks, and enqueue use one transaction. Reservations survive restart; accepted work retains its reserved capacity.

This budget bounds retained-result records, not the existing Sendblue state or total process memory. Stress tests must measure snapshot-copy memory and write latency.

Expired terminal records can be removed together. Live records are never evicted to make space. Authentication failures and polling do not consume request slots. Duplicate checks, capacity checks, and insertion occur in the same transaction.

## Persistence and migration

Use the existing GatewayStore and its atomic snapshot writer. Add a versioned migration from the existing version-1 state.

Legacy routes become logical routes with a Sendblue source binding. Legacy batches and work receive that binding's identity and destination.

Preserve batch IDs, admission UUIDs, turn IDs, execution bindings, callback tokens, provider handles, file references, deadlines, and delivery states.

Validate request-to-batch references in both directions. Reject legacy aliases that already create competing routes for one configured target; do not merge pending executions.

Validate migrated state before replacing the canonical snapshot. An invalid migration leaves the previous state intact. No pending message is resent during migration.

Pending-work validation compares the target and referenced source binding. Adding HTTPS must not invalidate existing Sendblue work merely because a new source exists.

A source with pending work cannot change its destination or disappear. Retained HTTP records preserve their account ownership through token rotation.

Completion uses one generic state transaction. A retained completion stores its result and retires execution work. An outbound completion stores prepared delivery and updates receipts.

Terminal events publish only after that transaction succeeds. Cleanup occurs afterward. Adapters cannot perform their own state transactions.

If persistence fails after Codex acceptance, the existing UUID recovery path remains authoritative. Neither restart nor an HTTP retry permits blind input resubmission.

## Concurrency limits

The queue orders work submitted through this gateway. It does not provide isolated conversations or transactions against external Desktop and CLI clients.

Both connectors share the configured conversation history. External input can race a start request or influence an active turn.

The router preserves the actual admitted turn ID and input boundary. The API must not promise stronger isolation than the selected Codex backend provides.

The known silent-connection problem after a daemon crash remains a separate issue. This refactor must not hide it behind successful readiness responses.

## Implementation order

0. Prove Desktop completed-commentary observation and audit direct/SSH input boundaries. Save version-matched evidence before promising backend parity.
1. Define common submission, source policy, completed commentary, terminal result, and completion-plan types. Preserve the CLI wire format.
2. Normalize source bindings and generic receipts. Add version-1 migration fixtures before switching the canonical state schema.
3. Implement ordered admissions and shared-turn steering with the existing route worker.
4. Extract Sendblue authentication, formatting, callbacks, rate limits, upload policy, and presence handling into its adapter.
5. Add retained completion, capacity reservation, expiry, authenticated POST/GET, and HTTPS-only startup.
6. Connect scoped completed-commentary observation to bounded gateway subscriptions. No connector network operation runs inside the execution callback.
7. Implement SSE framing, resume/reset behavior, and an ESP-IDF client example.
8. Run migration, race, failure, stress, and live transport gates. Reload the live gateway only after tests pass and its queue permits restart.

Architecture and migration work can proceed independently of gate 0. The full requested feature cannot ship as complete while that gate remains open.

## Verification gates

- Existing Sendblue configuration starts unchanged; HTTPS-only configuration starts without Sendblue credentials.
- Migration preserves queued input, uncertain admission, accepted work, and uncertain delivery without duplicate effects.
- Concurrent duplicate POST requests create one queued request. A lost response followed by a retry returns that same request.
- Conflicting payloads return `409`; unauthorized callers cannot inspect results or select another execution target.
- Sendblue, HTTPS, then Sendblue input steers one active turn in admission order. Both participating connectors receive the shared result.
- Simultaneous input through both connectors creates one execution lane and retains the correct response destination.
- Restart before admission, after admission, and after terminal persistence preserves identity and results.
- An uncertain admission stays unresolved without replay. An uncertain Sendblue delivery reports route blockage to queued HTTP callers.
- Token rotation preserves access; source removal and pending target changes fail safely.
- Retention removes only expired terminal records. Capacity rejection never removes live work or rejects an existing duplicate lookup.
- A state-write stress probe exercises the configured record limit with large valid requests and results. Adjust the default before release if needed.
- Sendblue attachments, callbacks, rate limits, typing indicators, and nonblocking read receipts retain their behavior.
- HTTP uses plain text outcomes and structured notices without SMS formatting or provider uploads.

## ESP32 client requirement

Include HTTPS as the second working connector in this build. The connector must support a future ESP32 client.

The device submits a JSON prompt with a caller-generated request UUID. It can disconnect while Codex works and retrieve the result later.

The device saves its pending UUID before submission. After a lost response or reboot, it retries that UUID instead of creating another request.

The API uses standard HTTPS, bearer authentication, and JSON. It requires no browser cookies, JavaScript SDK, inbound device port, or persistent connection.

The ESP-IDF HTTP client supports HTTPS and connection reuse. See [Espressif HTTP client documentation](https://docs.espressif.com/projects/esp-idf/en/v6.0/esp32/api-reference/protocols/esp_http_client.html).

Clients validate the server certificate and use bounded response reads. The ESP32 example must not assume a complete result fits in one receive buffer.

Add an ESP-IDF example that submits text, consumes SSE incrementally, and retrieves the durable result after reconnecting. Polling remains an optional fallback.

Automated probes must simulate a lost submission response, interrupted result download, network reconnection, and client restart with a saved UUID.

Distinguish protocol tests and example compilation from tests on physical ESP32 hardware. Do not claim hardware validation without a device run.

WebSocket is outside this first build. SSE supplies server-to-device updates. Reconsider WebSocket if continuous two-way communication becomes necessary.

Both Sendblue and HTTPS must use the same gateway admission and recovery code. Two working connectors are a release requirement for the modular refactor.


## Native completed commentary

The common gateway emits completed user-facing commentary messages, then the terminal result. It does not emit model tokens, draft snapshots, or replacement revisions.

Each commentary event has execution identity, native item identity, and full text. The gateway binds it to the admitted submission and its immutable source.

Only explicitly classified commentary is eligible. Reasoning summaries and internal reasoning are excluded from this gateway stream. Existing CLI output remains compatible.

Direct and SSH sessions have explicit item/completed notifications. The gateway must pass an observation callback and preserve completion evidence through normalization.

Apply the admitted user-message UUID boundary to buffered events and recovered history on all backends. A turn ID alone is insufficient for joined turns.

Deduplicate stable native identities, not text. Distinct completed items with identical text must remain distinct. Historical pre-admission commentary must never leak into a request.

If recovery loses identity continuity, advance the request's observation generation, reset its progress stream, and baseline historical items. Do not present old commentary as newly generated output.

Sendblue does not subscribe to commentary by default. It retains final messages, attachments, typing indicators, and nonblocking read receipts.

## Desktop completion gate

The current Desktop adapter ignores its commentary callback. Its ordinary agent-message snapshots contain evolving text without a proven completion flag.

A stable string, a later snapshot, or a subsequent item is not sufficient evidence of completion. Waiting for terminal status is not live commentary parity.

A possible read-only supplement is the paginated rollout's authoritative ItemCompleted record. Its thread, turn, and native item identity must match validated Desktop history.

The record proves completion; ordered Desktop history proves that the item follows the admitted UUID boundary. Neither source replaces the other's validation.

Source inspection supports this candidate, but does not prove timely runtime visibility. Rollout records can flush asynchronously or fail to persist.

Gate 0 requires a dedicated test conversation with multiple commentary messages and a delayed operation before the final response. The Desktop app remains running.

The probe must demonstrate these facts:

- No commentary appears before its authoritative completion record
- Completed commentary appears while the turn is still active
- Thread, turn, item, source, and admitted-input identities match
- Partial JSONL records, delayed writes, reconnection, and replay do not produce drafts or duplicates
- The observation path is read-only and requires no extra writer, lock takeover, or input resubmission
- Unsupported history modes and unavailable completion evidence remain explicit limitations

Use a bounded reader on the validated rollout path if the candidate passes. Bound startup scanning, partial records, and retained offsets.

Persisted completed data must never come from arbitrary caller paths. Revalidate session identity after rotation, truncation, or reconnect.

If this candidate fails, revisit completion observation before claiming Desktop parity. Do not silently substitute draft updates or terminal-only commentary.

## HTTPS event stream

```http
GET /v1/routes/assistant/requests/<request_id>/events
Authorization: Bearer <token>
Accept: text/event-stream
```

The endpoint uses the same account, route, and request authorization as result retrieval. Reconnection never bypasses those checks.

The gateway owns logical completed messages and subscriptions. HTTPS owns SSE encoding, authentication, heartbeat comments, and socket handling.

SSE event types are status, commentary, terminal, and reset. The terminal event includes final text and outcome after durable result persistence.

GET retrieval remains available independently of the stream. A lost connection neither cancels work nor creates another request.

For ESP32, the HTTPS codec divides an already-completed logical message into bounded JSON frames. This is transport framing, not incremental model output.

Example frame data:

```json
{"message_id":"opaque-id","part":0,"end":false,"text":"A portion of a completed message."}
```

Every encoded SSE frame, including its envelope, is at most 4 KiB. Splitting respects Unicode boundaries and counts JSON escaping.

Status, result notices, and other metadata must also fit this bound or use the same deterministic framing. Metadata limits are enforced before publication.

A client treats all parts as one completed commentary message or terminal result. It does not interpret parts as distinct assistant messages.

The gateway retains full text up to the existing 256 KiB semantic limit. Neither connector silently truncates commentary or final text.

The SSE cursor contains a stream epoch, logical-message sequence, and part number. The epoch combines a process nonce with the request's observation generation. Last-Event-ID identifies the last consumed frame within that request.

The replay ring retains whole logical messages and regenerates their frames deterministically. It never retains only an unusable suffix of a message.

Initial replay bounds are 2 MiB and 128 logical messages per request, with a 16 MiB global budget. Account for encoded size.

These are transient buffers, not a second durable event log. Old progress can be evicted. A gateway restart or loss of observation identity creates a new stream epoch.

An unavailable epoch, evicted message, or unusable cursor causes reset and current status. The client discards incomplete message assembly before continuing.

Reconnect can replay frames; delivery is not exactly once. Clients use message identity and part number to avoid duplicate display or storage.

Durable terminal results can regenerate final frames after restart or eviction. Replaying a result never re-executes the request.

After authentication, snapshot capture, replay watermark capture, and subscriber registration occur in one synchronous gateway operation. No await separates them.

Replay and current status precede later live frames. A committed result is visible even if the process failed before its original terminal publication.

Execution callbacks never await subscribers. Observer or transport failure cannot fail an otherwise valid Codex turn.

Initial limits permit 32 streams globally and four per HTTPS account. A heartbeat comment is sent every 15 seconds.

A writer stops on socket backpressure. It resumes from its cursor instead of accumulating a private unbounded queue.

A ten-second drain timeout or 64 KiB writable-buffer limit closes only the slow stream. Ring eviction during that wait causes reset on resume.

The completed terminal message ends the stream. The ESP32 client stops automatic reconnect once it consumes the terminal message's final part.

The proxy must flush events and permit heartbeats. Test the actual HTTPS proxy path, not only loopback HTTP.

Use the [SSE standard](https://html.spec.whatwg.org/multipage/server-sent-events.html) for UTF-8, event fields, blank-line framing, and Last-Event-ID handling.

## ESP32 streaming behavior

The ESP-IDF example uses bounded incremental HTTP reads and an SSE frame parser. It handles partial lines, UTF-8 splits, and several frames per read.

Each bounded JSON frame can use an ordinary JSON parser. The client sends text pieces to a display or storage sink without allocating the whole message.

Reset invalidates incomplete content in both the parser and the display or storage sink. The sink must support replacing or discarding that partial message; an append-only sink is insufficient. The example must not silently concatenate fragments from different epochs or message identities.

Persist the pending request UUID once per request. Keep streaming cursors in RAM; do not write flash for each frame.

After reboot, reconnect using the saved request ID and retrieve the current result or a fresh stream. Retry POST only with that same ID.

Example compilation and protocol probes do not constitute physical ESP32 validation. Record hardware validation separately when a device is available.

See [Espressif streamed HTTP examples](https://docs.espressif.com/projects/esp-techpedia/en/latest/esp-friends/get-started/case-study/protocols-examples/http-examples/http-client-example.html).

## Additional release gates

- Distinct identical-text commentary items remain distinct; replay of one native item does not duplicate it
- Pre-admission commentary stays excluded across Desktop, direct, and SSH execution, including lost acknowledgments
- Desktop drafts never enter the stream; completed commentary arrives before the final result
- Progress reaches participating requests; unrelated routes and requests receive no progress
- Subscription racing terminal persistence cannot lose the terminal result
- A failed terminal transaction cannot produce a successful terminal SSE event
- Unicode, JSON escaping, maximum-size messages, and fragmented network reads reconstruct exact commentary and final text
- Reconnect within a message resumes correctly; eviction and restart produce an explicit reset
- Slow readers and disconnected clients do not delay execution or exceed buffer limits
- Duplicate requests still succeed at capacity; accepted requests retain their completion reservation across restart
- The real TLS proxy flushes commentary before completion and passes heartbeats
- Native gateway and both connector contracts pass tests without phone-number placeholders or fake provider acknowledgments in HTTPS

## Evidence and consensus status

The reviewers accept one normalized gateway lifecycle with two concrete adapters. They reject a provider-shaped interface that forces HTTPS to implement dummy operations.

They accept complete native commentary messages and bounded SSE transport frames. Frames begin only after message completion; there are no draft or token events.

They accept the shared queue, source boundaries, atomic receipt/result persistence, versioned migration, and explicit delivery blockage.

The macOS Desktop feasibility probe passed using authoritative completion records matched to snapshots. Ordinary snapshot polling alone remains insufficient.

Source evidence includes gateway.ts observation and completion paths, turn-state.ts item/completed handling, and desktop-session.ts snapshot-only observation.

Desktop bundle inspection used /tmp/router-main-C5425b_s.js. It showed identical agent-message shapes at item start and completion, plus in-place text updates.

The reference Codex source supports a possible paginated ItemCompleted record path. Installed-version fixtures and a live dedicated probe must validate its applicability.

The accepted implementation sequence has been completed locally. The verification report records passing tests and the remaining proxy, firmware, and platform qualification limits.
