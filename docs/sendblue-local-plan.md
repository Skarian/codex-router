# Sendblue polling and LAN HTTPS plan

Status: implemented and deployed on 2026-09-27. See [verification](connector-verification.md) for results and remaining device qualification.

## Scope and current state

Use the official Sendblue TypeScript SDK for outbound-only message intake and replies. Keep HTTPS access on the local network. Preserve the shared gateway queue, source-specific results, commentary, media, typing, and best-effort read receipts.

The verified Cloudflare Quick Tunnel process (PID 31378) was terminated at the user's request. A subsequent process check found it absent. The router remains on HTTP loopback, `127.0.0.1:8787`; LAN TLS is not enabled. Targeted LaunchAgent and testing-script checks found no tunnel restart registration. That was the pre-implementation state. Polling and private LAN TLS are now deployed; the old receive-webhook registration was removed.

## Decisions

### Sendblue transport

- Pin a verified release of the official `sendblue` package. The reference inspected is version 3.15.0, commit `f51917c93eaa3204ae8ae1c854e57e1a8ba95e8e`.
- Polling becomes the default account mode. Webhook mode remains an explicit option. Only webhook mode requires a public URL and webhook secret or exposes webhook/callback handlers.
- Use typed SDK methods for list, send, status and typing. Use the SDK's generic POST for multipart `/api/upload-file` and `/api/mark-read` where generated methods are absent. The URL-based media upload method is not a substitute for uploading local bytes.
- Force `maxRetries: 0` and `logLevel: "off"`. Keep router-owned request scheduling, bounded response bodies, full-response deadlines, cancellation and safe metadata-only errors. Honor the account list budget and existing shared per-line send budget.
- Defer SDK account-event SSE. It is outbound-only but non-durable and still needs list-based recovery. It adds another connection lifecycle without removing polling.

### Durable polling

One serialized poller per account runs approximately every five seconds. It never accumulates overlapping jobs. Rate limits and backlog processing take priority over cadence.

Persist a completed-through checkpoint C and route activation boundaries in the existing state store. For each sweep, freeze these bounds:

- lower = max(account activation boundary, C minus 24 hours)
- upper = min(current time, C plus 12 hours)

List inbound messages for configured lines, ordered by `updatedAt` ascending, using inclusive updated-time bounds and every offset page. Validate pagination and provider rows. Admit matching messages through the existing durable receive path and message-handle deduplication. Advance C to the frozen upper bound only after every page and admission succeeds. Restart incomplete sweeps at offset zero. Continue backlog sweeps immediately under the rate limiter.

The 12-hour advance means each newly covered interval remains inside later overlapping scans, even after a long outage. Do not scan an entire multi-day backlog once and then jump straight to now. Do not add repeated stable-ID-set convergence loops: they add complexity without proving provider snapshot consistency.

Use a rolling eligibility floor for `date_sent`: max(route activation boundary, current time minus 29 days). This prevents an old message updated today from rerunning after the existing 30-day dedup record expires. Invalid matching rows, malformed or nonprogressing pages, and persistence failures must produce visible degraded intake without advancing the checkpoint. Bound per-page bytes and in-flight work; continue unfinished scans without overlapping pollers.

A checkpoint gap beyond 29 days requires explicit recovery. It must not silently skip history or replay expired identities. Fresh routes persist their activation boundary before the first request. For this installation, select and persist a migration boundary before the tunnel shutdown, with conservative overlap and existing receipts preserved. Record the selected boundary during migration; do not initialize to deployment time and lose downtime messages.

The overlap and recovery horizon are router policy, not Sendblue guarantees. Offset pagination has no documented snapshot or maximum indexing delay. This plan provides repeated bounded reconciliation, not a universal no-loss guarantee for arbitrary late visibility or continuous page mutation.

### Outbound uncertainty

Omit `status_callback` in polling mode. A successful response with a provider handle retains existing acceptance semantics. Status lookup can reconcile a known handle.

Stop automatic retries after ambiguous sends in either mode. If the provider may have accepted a send but the response/handle was lost, preserve durable unresolved state for the existing operator resolution flow. Do not infer identity from matching text or timestamps. Retry only failures that establish the send was rejected and are eligible for retry. Normal message sends have no documented idempotency key.

Preserve uploaded media, read receipts and typing. Presence failures remain nonfatal. Uploaded files continue to use provider-hosted URLs; the Mac does not need to serve them publicly.

### LAN HTTPS

Add optional native TLS certificate/key configuration and an explicit private IPv4 listen address. Keep loopback as the default. Require TLS for nonloopback access and retain bearer authentication. Reject an unspecified/wildcard public binding as the LAN configuration.

Provision a server certificate with the selected LAN hostname/IP in its SAN and a trusted issuer. Provision that CA on clients, including the ESP32 example. Never disable certificate verification. Do not configure router port forwarding, a public tunnel, or public DNS. LAN reachability is the deployment boundary; binding alone is not a firewall against a separately routed external network.

Keep listener configuration independent of connector selection. Polling must start without a public URL or signing secret. Keep CLI administrative status/resolution usable; disable webhook-secret-dependent HTTP status for poll-only accounts or give it an explicitly authenticated replacement only if needed.

## Implementation order

1. Add SDK adapter and conditional account configuration; preserve existing transport safeguards and file/presence behavior.
2. Add durable polling metadata, state migration, admission/catch-up logic, and observable degraded state.
3. Remove callback dependence in poll mode and prevent ambiguous resend across modes.
4. Add native TLS/private bind configuration and document client trust setup.
5. Pass focused regression and failure tests, then live provider and LAN probes.
6. Back up config/state, stop the gateway safely, persist the migration boundary, remove obsolete public URL/secret requirements, and restart with polling. Remove only this router's old Sendblue webhook registration; preserve unrelated subscriptions. Verify public tunneling remains stopped.

## Required verification

- Multi-page bursts, equal timestamps, late visibility within overlap, outbound/group/unconfigured sender filtering, and attachments.
- Reproduce offset removal during a historical sweep; prove the skipped message is admitted by the next bounded overlapping sweep before aging out.
- Crash after admission and before checkpoint, restart mid-page, storage failure, API failure, rate limiting, and shutdown during body read/backoff.
- Fresh bootstrap, migration downtime, route addition, old message updated today, and beyond-horizon recovery.
- SDK retries/logging disabled; response cap and body deadline retained. Provider accepts send then drops connection: no second physical send.
- Real Sendblue text and media both directions with the tunnel stopped; read receipts/typing remain best effort.
- Trusted LAN TLS from a second client: POST, final GET, commentary, heartbeat and reconnect. Wrong token, wrong hostname and untrusted certificate must fail. ESP32 firmware/hardware validation remains separate until available.
- Confirm no tunnel process/restart registration and no configured callback to the old public URL.

## Evidence and consensus

Live read-only message-list probes used existing credentials without printing content or secrets. Six pages returned twelve unique messages, matching a single-page query. `updatedAt` sorted ascending; equal lower/upper timestamp bounds included the matching row; a future interval returned no rows. Media fields were present. Both `updatedAt` and `updated_at` were accepted, but the implementation will use the typed spelling. These probes do not establish concurrent mutation or maximum visibility delay guarantees.

Evidence scripts: `/tmp/router-sendblue-list-probe.mjs` and `/tmp/router-sendblue-pagination-probe.mjs`.

Independent green, red and adjudication reviews rejected a whole-backlog checkpoint jump. Cross-examination replaced it with bounded overlapping advancement. Green withdrew its stable-ID convergence proposal after that clarification. Final reviewer confidence is about 94% in the practical architecture, subject to the tests above; this is not a measured provider delivery guarantee.
