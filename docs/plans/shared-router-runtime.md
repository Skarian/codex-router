# Shared router capabilities and connector-neutral request runtime

Status: accepted implementation plan after independent green, red, and adjudication reviews and a revision round. Source baseline: `80e3569ec3a53525d29cde652ea6fb21ae558282`.
This is an implementation plan, not an implemented feature or a release approval.

## Outcome and scope

CLI remains the default. Gateway is optional. HTTP is an optional gateway connector that can discover and address every configured agent. SendBlue can use fixed conversation-to-agent mappings. Both use the same durable request operations and semantic events.

Extract the durable coordinator from provider and HTTP concerns. Do not rewrite execution transports or build a general plugin framework. Remove native TLS and HTTP account authentication in favor of an explicitly trusted loopback backend and an optional external proxy. Do not publish a package or change the live Windows deployment while implementing earlier phases.

## Ownership and dependencies

| Component | Owns | Must not depend on |
| --- | --- | --- |
| Agent catalog | Agent lookup, public id/label projection, target uniqueness | Gateway process, provider credentials |
| Execution sessions and command helpers | Owner discovery, resume, admit/steer with supplied intent, semantic observation, guarded interrupt, correlation | HTTP, SendBlue, durable runtime lifecycle |
| RequestRuntime | Durable receipts, target lanes, admission intents, reconciliation, results, bounded semantic subscriptions, durable delivery jobs | GatewayConfig, phone fields, provider SDK, HTTP/SSE objects |
| Gateway host | Construct runtime/store and concrete adapters; start/stop intake and diagnostics | A second submission state machine |
| Connector adapters | Normalize input, select agent, supply policies and destinations, format output, execute provider effects | Direct independent execution or blind retry of ambiguous admissions |

CLI calls catalog and ephemeral command helpers without opening runtime state. Gateway constructs the optional runtime and passes it to connectors. No no-op store, mandatory daemon, pass-through RouterCore facade, or dynamic plugin registry.

Exactly one runtime owns the chain from external request identity to persisted execution intent. It commits that intent before calling ExecutionSession.admit. The session performs the backend effect and reports evidence. It does not invent a replacement intent or persistent retry queue.

Serialization applies to this runtime's requests, not independent CLI or Desktop processes. Existing backend ownership and expected-turn checks remain authoritative across processes.

## Module changes

- Add `src/agent-catalog.ts`: shared lookup and public agent summaries. Preserve duplicate `(sshHost, threadId)` rejection and execution-binding verification.
- Extract `src/request-runtime.ts` from durable portions of `gateway.ts`; move neutral request/result/event types to `src/request-types.ts`.
- Refactor the current state module in place or rename it to `request-state.ts`; retain atomic writer, locking, filesystem permissions, and poisoned-writer behavior.
- Separate semantic buffering into `request-progress.ts`; HTTP SSE encoding lives in `http-progress.ts`. Move existing framing code rather than rewrite its tested limits.
- Add a small durable outbox worker module using the same store. Reuse send-attempt settlement semantics and connector-supplied rate limits; do not add another database or broker.
- Rename the HTTP handler to `gateway-http.ts`. Replace account/route lookup with catalog and runtime operations.
- Move SendBlue types, mappings, inbound dispatch, typing/read receipts, provider formatting and upload actions out of runtime into concrete adapter code.
- Split file handling into immutable staging/reference cleanup and provider upload/formatting. Preserve safe local/remote copying and symlink protections.
- Keep `execution-session.ts`, Desktop/SSH/stdio transport logic and platform storage primitives unless a targeted test proves a necessary adjustment.

These are responsibility boundaries, not a requirement to create one class for each row. Avoid modules that only forward calls.

## Shared operations

Catalog exposes `listAgents()` and `getAgent(id)`. Public discovery returns id and label; it never returns cwd, raw configuration, credentials or private host paths. Backend capabilities are reported when actually known, not inferred by opening every agent during listing.

The runtime exposes submit, request lookup, bounded subscription, guarded cancellation, diagnostics, start and close. Submission includes agentId, stable origin namespace, externalId, normalized input and trusted adapter policy/destination references. HTTP clients cannot submit execution settings, source namespaces, filesystem paths or destination policies.

Request references include origin plus agent and external identity internally. HTTP uses one shared namespace and `(agentId, request UUID)` publicly. SendBlue deduplicates by `(accountId, provider message handle)` even if a later mapping selects a different agent. A separate conversation identity is `(accountId, receiving line, sender)`. Serialize tuples without delimiter ambiguity. Freeze selected target and reply destination at intake.

Do not treat origins as authentication accounts. They are necessary for deduplication, attribution and delivery after restart.

### Submission and recovery

1. Resolve the configured target; find committed duplicate before reserving capacity.
2. Exact HTTP retry with matching payload returns its existing request; changed payload returns conflict.
3. Reserve result and delivery capacity, then commit intake before acknowledging it.
4. Runtime serializes decisions for the target, prepares input, and commits exact UUID, expected turn and execution binding before dispatch.
5. An active turn receives steering, not a queue that waits for normal completion. Preserve the existing admission serialization and capability errors.
6. Definite non-admission may return input for another attempt. Uncertain admission remains unresolved and uses restore/correlation; never create a fresh identity to retry it.
7. Unknown or changed stored target bindings fail closed. Removing an agent must not discard pending work.

### Cancellation

`cancel(agentId, expectedTurnId)` runs through the same short target-operation lane as admission. It does not wait for the entire observation promise or outbound delivery. Attachment preparation must also run outside this critical section. Preserve order within each origin, but allow ready input from a different origin to steer while attachment preparation is pending. Revalidate target/turn state after preparation and before the intent transaction. Bound preparation tasks; do not allow a slow origin to create unlimited work. Cancellation of a known active turn bypasses pending preparation. Input still being prepared reports that state and has not yet been admitted to Codex. Reuse the current session when available; otherwise discover an owner and verify the expected turn.

HTTP returns 202 with `interrupt_requested` after an acknowledged interrupt request, 200 with `already_finished` when the expected turn is finished and no successor is active, and 409 for a successor or stale identity. An unconfirmed interrupt returns 503 with `interrupt_uncertain`; clients must observe status, not automatically retry. An unsupported backend returns 409 with `interrupt_unsupported`. Requested is not completed: normal observation supplies the eventual interrupted result. If admission cannot establish the target turn, return unresolved/conflict. Never interrupt whichever successor turn happens to be active.

No asynchronous durable cancel queue in this scope. No automatic cancel retry on restart. Cancellation does not remove waiting input or resolve provider sends. An HTTP disconnect closes its subscription, not the Codex turn. CLI keeps its existing ephemeral semantics.

### Semantic progress and results

Represent status, backend-published reasoning summaries, commentary, terminal result and replay reset independently of HTTP. Do not expose raw model internals or add transcript scraping. Preserve backend capability limitations.

Every participating origin can consume semantic progress without enabling HTTP retention. Preserve backend item identity when supplied; otherwise use an observation-epoch sequence for replay within that runtime session. Do not discard valid semantic summaries solely because their backend event has no item ID. Isolate failed or slow observers. Use bounded buffers and explicit replay reset; commentary need not survive restart. Persist final results before terminal publication. Results describe gateway-observed operations, not full chat history.

HTTP owns SSE frames, Last-Event-ID parsing, heartbeat, stream quotas and backpressure. Preserve 4096-byte frames and existing ESP32 reassembly/reset semantics. Without accounts, apply global and per-request stream limits rather than treating a caller-supplied header as identity.

## State v3 and completion/delivery split

Use one versioned state snapshot and writer. Logical records are target execution state, origin-scoped receipts, canonical completion records, destination outbox jobs, and connector checkpoints. State must reference stable execution bindings; agent names alone cannot authorize rebinding old work.

Execution state is idle, queued/batching, active with optional pending admission, or unresolved. Outbox state is independent. More than one destination may receive a completion; remove the single-outbound-source assertion.

Completion protocol:

1. Resolve all pending admission evidence before attributing completion.
2. Stage eligible output artifacts into immutable local storage. This phase may need local or SSH I/O, but performs no provider upload.
3. Sync staged files before referencing them in canonical state.
4. In one transaction, commit the canonical terminal result and one delivery job per participating destination, including immutable artifact references; clear active execution.
5. Only after commit, publish terminal events and release execution-only files. The next turn may start while deliveries remain pending.
6. Delivery workers perform provider uploads, freeze formatted payloads, then persist sending state before recipient effects. Reuse accepted/failed/uncertain semantics; never blindly resend an uncertain part.

A crash before the completion commit leaves recoverable execution and possibly orphan staged files. A crash after commit leaves durable result/outbox references. Cleanup deletes only unreferenced artifacts. Pending delivery pins its completion and files, regardless of result retention expiry.

Ordering is per destination, including messages from that conversation after an agent selection change. Preserve shared per-line rate limits across destinations. One destination's uncertain send blocks its later delivery, not another agent's execution or HTTP results.

Bound intake reservations, retained results, queued delivery jobs, file count and aggregate spool bytes. Reserve capacity before accepting new work that promises delivery. Matching duplicates do not consume another reservation. Reserve conservatively per accepted provider-bound batch, including steering. Merging batches into one destination job releases excess reservations at completion. Persist reservations and consume/release them in the same transactions as their owning records. Content omissions and overload must be explicit, not silent loss.

Initial limits are conservative engineering defaults, not throughput claims:

| Resource | Default / accounting |
| --- | --- |
| Retained requests and result bytes | Preserve existing 1024 / 8 MiB limits and pre-admission reservation behavior |
| Outbox jobs/reservations | 128 global, 32 per conversation destination |
| Encoded outbox metadata | 2 MiB per job, reserved before acceptance; includes JSON escaping and provider fields |
| In-flight attachment preparations | One per origin, four globally; ready text needs no preparation slot |
| Staged artifact bytes | 512 MiB total, including temporary staging and pinned files |
| One provider-bound completion | At most 16 files and 100,000,000 bytes aggregate (decimal 100 MB), including the per-file limit |
| Staging duration | 60 seconds per completion, abortable |

Reserve job slots and bounded result/delivery metadata per accepted provider-bound batch before acknowledging intake. Coalescing releases excess reservations. Artifacts remain best effort, as in the existing connector: do not reserve a maximum-size media file for every text message. Enforce remaining spool capacity incrementally during staging; lack of media capacity produces an explicit omission notice, not loss of the text result. Shared files count once physically. Job/metadata exhaustion rejects new provider-bound intake before its receipt is created; already accepted reservations cannot be stolen by newer work. Preserve independent result reservations, and never evict pending/unresolved records to make room.

Enforce count/byte/deadline while streaming copies, not after allocation. File/content/size/count/deadline/capacity omissions produce explicit notices and bounded output. Disk-full, failed sync, or failed canonical persistence leave work blocked/recoverable rather than pretending success. Abandoned staging files count toward the spool ceiling until cleanup removes them; crash cleanup cannot remove files reachable from state. Bound filenames, media types and provider-returned URLs before freezing parts; total serialized delivery metadata cannot exceed its reservation. Oversized optional media metadata produces an explicit omission, not an unbounded snapshot. Migrated accepted work above new limits remains intact and blocks new intake until capacity recovers; do not discard it. Make limits injectable for tests; only expose operator overrides if actual qualification requires them. Do not add a configuration tuning surface merely because tests need tiny limits.

Keep existing SendBlue account-wide polling checkpoint behavior in this pass. Capacity rejection must prevent checkpoint advancement past an unaccepted message. This can pause other conversations in that account; HTTP remains independent. Per-conversation polling cursors/spill queues are deferred.

## Configuration and HTTP contract

An existing agent requires no second HTTP route entry:

```toml
[[agents]]
id = "home"
label = "Home"
cwd = 'C:\projects\runpod'
thread_id = "EXISTING_CHAT_ID"
model = "AVAILABLE_MODEL"

[gateway.http]
port = 8788
```

Presence of `[gateway.http]` enables the agent API. Default port is 8787. Bind only to literal `127.0.0.1`. No TLS, listen_host, HTTP account, token or top-level route fields. `[gateway]` still holds optional state/retention limits. SendBlue polling alone opens no listening socket.

Retain optional SendBlue webhook mode without forcing the agent API: require `[gateway.http]` and permit `api = false` for a webhook-only listener. Public callback origin remains HTTPS and becomes `public_url` on its SendBlue account, used only in webhook mode. Retain webhook signatures and callback capabilities even when general HTTP authentication moves to a proxy.

```toml
[[gateway.sendblue]]
id = "phone"
api_key_id = "..."
api_secret_key = "..."

[[gateway.sendblue.conversations]]
sender = "+15555550100"
sendblue_number = "+15555550200"
agent = "home"
```

Conversation identity is derived; there is no user-maintained route ID. Reject duplicate ambiguous mapping tuples. Multiple conversations may select one agent; multiple accounts/lines are supported. Interactive agent switching is deferred, but mappings are connector policy and cannot change previously admitted delivery destinations.

| HTTP operation | Contract |
| --- | --- |
| `GET /v1/agents` | Sanitized catalog |
| `POST /v1/agents/:agent/requests` | Existing UUID/text payload; 202 after durable acceptance |
| `GET /v1/agents/:agent/requests/:id` | Current status and retained result |
| `GET /v1/agents/:agent/requests/:id/events` | SSE presentation of common events |
| `POST /v1/agents/:agent/cancel` | JSON expected_turn_id; guarded synchronous interrupt request |

Keep existing body/prompt limits and 404/409/413/415/429/503 behavior where applicable. Runtime errors are typed domain errors; adapters map them to HTTP or messaging presentation. Unknown agent/request is 404. Add no remote recovery-resolution API; operator mutation remains a stopped-service CLI command backed by the same state logic.

Update diagnostics from route-centered to agent/request/destination fields. Separate execution health, progress availability, and delivery blockage. A failed delivery is not an idle or failed execution.

## External HTTPS and authentication

Stock Caddy is a documented option, not a dependency. Use local TLS and Caddy `basic_auth` with a hashed password in the reference recipe. Update the ESP32 sample from fixed Bearer to standard Basic authentication over verified TLS. Other edge authentication remains an operator choice, not router account configuration.

All API clients admitted by the proxy share access to all configured agents and retained API results/cancellation. Local processes can access the loopback backend. This is an intentional trust change, not a preservation of old account isolation. The runtime does not authorize from forwarded headers. Protect the anonymous loopback server from DNS rebinding: require exactly one canonical Host header matching `127.0.0.1:<bound port>` on backend requests; reject missing, duplicate, malformed or other hosts before dispatch. Configure Caddy `header_up Host {upstream_hostport}`. Retain no CORS grants, JSON-only mutation bodies, unsupported-preflight rejection and side-effect-free GETs. Test hostile Host on both GET and POST, and valid proxy rewriting. Host validation is not authentication against local programs.

Keep private CA storage under the stable Windows startup identity and provision only its public root to clients. Proxy LAN8787 to loopback8788. Bind Caddy explicitly to the LAN IP, disable port80 redirects and HTTP/3 for this recipe. Use normal reverse_proxy SSE behavior, no automatic POST retries or buffering tweaks.

Webhook deployments need a separate recipe: protect the agent API at the edge, while passing only known provider webhook/callback paths to their existing application authentication. Do not remove provider authentication or apply Basic blindly to SendBlue requests.

## Test installation replacement

Updated scope: this branch has no deployed users. Remove legacy parsers, migration commands, markers, and historical-result variants.
Reject unsupported state versions without rewriting them. Replace only disposable test configuration and state during deployment.
Reconcile pending operations before resetting a test installation. Preserve the old installation until qualification passes.
ESP32 firmware must still reject an incompatible pending record rather than silently replay or retarget it.

## Implementation slices and gates

1. Catalog and contracts: extract lookup/public listing and neutral types; preserve CLI output and no-store behavior. Add contract tests for target uniqueness and sanitized discovery.
2. Runtime extraction: remove HTTP/provider construction dependencies, preserve pre-effect journaling and existing recovery. Keep adapters functional while changing internal boundaries; no live deployment yet.
3. State v3 and outbox: implement completion transaction, staging references, independent delivery, bounds and schema rejection fixtures. Prove crash recovery before adding public operations.
4. Common events/cancel: remove retention gating, move SSE codec, serialize guarded cancellation without blocking active steering. Test slow observers and admission/cancel races.
5. Connectors/config: direct agent HTTP API; optional loopback listener; SendBlue conversation mapping, multiple destinations; remove native TLS and HTTP accounts. Update CLI diagnostics and stopped-service administration.
6. Clients/docs/deployment: README, CLI reference, contracts, HTTP guide, SendBlue guide, ESP32 endpoints/auth and Caddy recipe. Validate runnable examples.
7. Isolated qualification: full suite plus real Caddy/Linux/Windows probes using a candidate tarball in separate prefixes, ports, state directories and disposable chats. Leave household tasks and package unchanged.
8. Household cutover: only after qualification and review of the rollback checkpoint, replace stopped Windows test state and config, update the existing startup script to launch Caddy and router, and run Mac-to-Windows verification. Do not replace startup with a new service framework. Inspect the actual script before editing it. Do not publish or push release tags without explicit instruction.

Dependencies: slices 2–3 retain provisional compatibility only inside development commits, not permanent config branches. Do not point the household gateway at an intermediate build. Update existing tests to express the new contract; do not delete durability assertions merely because filenames change.

## Required proof matrix

- CLI list/send/cancel without gateway state, listener, Caddy or new background process.
- HTTP-only, SendBlue polling-only, webhook-only and mixed configurations; no listener for polling-only.
- Catalog includes every agent, exposes no secrets, rejects unknown target and duplicate execution bindings.
- HTTP + two SendBlue conversations share one target, steer one active turn and receive correctly attributed result/destinations.
- Semantic progress for non-HTTP origins; backend unavailability is explicit; no raw tool/hidden reasoning expansion.
- Slow/failed SendBlue upload does not delay post-staging HTTP final or next execution; ordered delivery and rate limits survive.
- Outbox/result/spool limits, rejection before acceptance, duplicate admission at capacity, checkpoint backpressure without lost messages.
- Crashes before/after receipt, intent, Codex acknowledgement, file staging, completion commit, upload, and send settlement.
- No blind replay after uncertain admission/send; cleanup retains referenced files and bounds abandoned staging.
- An active turn completes during attachment preparation: the later-admitted batch starts or joins the newly current turn and never inherits the old result.
- Cancel before/after steer, stale expected turn, unsupported backend, unresolved admission, lost interrupt acknowledgement, external CLI/Desktop race; block attachment preparation and prove known-turn cancel and ready HTTP steering are not held behind it.
- SSE commentary before final, large-message framing, cursor reconnect/reset, heartbeat, disconnect without turn cancellation, slow-client limits.
- Unsupported state rejection without rewriting files; current-state recovery with pending operations.
- Host validation rejects hostile/missing/duplicate headers; Caddy rewrites Host correctly.
- Caddy valid TLS/auth succeeds; absent/wrong credentials fail at proxy; backend inaccessible on LAN; no unexpected public/wildcard listener; provider callbacks retain their authentication.
- Real Windows Mac-to-PC agent discovery, message, progress, steering, guarded cancel and retained result; independent Caddy/router restart and startup-order tests.
- Linux installed-package/Caddy live-model smoke; macOS local CLI/runtime checks without stopping Desktop; no claim of ESP32 hardware validation without hardware.

Planning review is source-based, not a fresh runtime qualification. Report observed results separately from intended tests.

## Out of scope

Interactive SendBlue picker, per-client ACLs, complete chat history synchronization, generic plugins, cloud tunnels, managed certificates inside router, service-manager framework, global cross-process execution serialization, and automatic publication.

## References

- Current admission ordering: src/gateway.ts, persisted intent immediately before session.admit.
- Current coupling: src/gateway.ts completion/upload and exclusive delivery state; src/gateway-progress.ts HTTP/SSE; src/config.ts fixed routes.
- Caddy authentication: https://caddyserver.com/docs/caddyfile/directives/basic_auth
- Caddy proxy/SSE: https://caddyserver.com/docs/caddyfile/directives/reverse_proxy
- Caddy local TLS: https://caddyserver.com/docs/automatic-https

## Consensus record

Green, red and adjudication reviewers accepted the revised plan with no remaining architectural blockers. Reviews covered the current source, tests, docs and ESP32 client. No implementation or live qualification was performed.

Revisions from review: conservative job reservations with best-effort media; explicit account-wide polling backpressure; Host validation for tokenless loopback; explicit test installation replacement; fail-closed ESP32 upgrade; short cancellation/admission critical sections; preserved accepted work above new limits.

One reviewer suspected the catalog would newly reject CLI aliases. Source inspection disproved it: config.ts already rejects duplicate host/thread targets. Preserve existing behavior.

If implementation tests require changing these contracts, report the evidence and revise the plan rather than silently expanding scope. A passed plan review does not authorize publication or claim runtime reliability.
