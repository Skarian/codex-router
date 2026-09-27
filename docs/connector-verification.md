# Historical connector verification

For the current qualification matrix, see [release qualification](release-qualification.md).

The sections below record separate earlier probes. Their test counts and deployment details are historical.

Verified on macOS on 2026-09-27. Implementation tests used isolated state directories and HTTP listeners. The rebuilt gateway was then deployed to the live Mac service after the queue was confirmed idle. Configuration and state backups were saved before the restart and version-2 migration.

## Earlier local deployment

The public Cloudflare tunnel is stopped. Its old Sendblue receive-webhook registration was removed without changing unrelated subscriptions. Sendblue now polls through the official SDK. The live gateway uses native TLS on the Mac's private address, `192.168.1.106:8787`.

The config and state were backed up before cutover. The persisted polling boundary starts at `2026-09-27T06:00:00.000Z`, before tunnel shutdown. Credentials remain in the owner-only router config. The client CA is `~/.codex-router/tls/ca.crt`; private keys stay on the Mac.

Results from that probe:

- All 264 TypeScript tests pass on macOS and Linux, with no failures or skips. Linux ran with a clean dependency install as an unprivileged user. An initial root run bypassed a file-permission failure test; the unprivileged rerun passed.
- The SDK passed real local HTTP tests for multipart bytes, response-loss uncertainty, stalled-body cancellation, and disabled implicit retries.
- Real Sendblue list and status reads passed. Live test text and image reached `DELIVERED`. Read receipt and typing start/stop API calls succeeded. No callback URL or public receiver was used.
- An isolated Linux client reached the Mac's private LAN endpoint with verified TLS. Missing authorization, an untrusted CA, and the wrong certificate hostname were rejected.
- The real Desktop turn produced commentary at 4.3 seconds and its final result at 29.7 seconds. A heartbeat and Last-Event-ID reconnect passed. Twenty concurrent duplicate submissions, 100 reads, and changed-payload rejection passed in about 178 ms, without another turn.
- A live service restart preserved all 13 receipts and resumed the polling checkpoint with verified TLS.
- ESP32 private-CA configuration was added. Host parser tests passed with ASan/UBSan; CMake embedding checks passed. Firmware and physical-device TLS remain unverified because ESP-IDF and hardware were unavailable.

A fresh user-originated Sendblue text/image round trip is still awaiting the requested test message. Provider reads, outgoing delivery, live poller startup/checkpoint progress, and synthetic failure recovery passed; these do not substitute for that final manual inbound check.

### Polling stress

The stress probe used real local HTTP, the official SDK, the production poller, durable state writer, and gateway admission. Execution scheduling was disabled to isolate intake; no outgoing messages were sent.

- A 1,000-message backlog failed on page four after 300 durable admissions. The checkpoint did not advance; reopening recovered all 1,000.
- Across restart and overlap replay, 2,300 receive calls produced exactly 1,000 receipts and queued events.
- Mutable offset pagination skipped one historical row in the first sweep. The next bounded sweep recovered it: 249 became 250.
- An injected state-write failure left 50 messages on disk and the checkpoint unchanged. Reopen recovered all 500 without duplicates.
- Total: 36 HTTP requests, 22.81 seconds, and about 193 MiB peak RSS. These measurements are not throughput guarantees.

Evidence: `/tmp/router-sendblue-stress-report.json`, `/tmp/router-lan-probe-result.json`, `/tmp/router-lan-load-result.json`, `/tmp/router-local-restart-result.json`, `/tmp/router-polling-tests-final.log`, and `/tmp/router-polling-linux-tests.log`.

## Implemented

- One gateway execution lane with immutable source identity and neutral retain/deliver completion behavior.
- Optional Sendblue and HTTPS accounts, including HTTPS-only startup.
- Version-1 state migration that preserves pending input, admission identity, callback tokens, and provider handles.
- Authenticated POST/GET and request-scoped SSE, durable results, duplicate handling, and capacity reservations.
- Completed commentary from direct/SSH notifications and validated Desktop completion records.
- Bounded replay, fragmented SSE frames, reconnect/reset handling, and slow-client isolation.
- An ESP-IDF example with a host-tested parser and receiver.

Conversation transcript synchronization and automatic cross-client delivery remain outside this build.

## Live Desktop evidence

The test chat used Codex 0.157.1 and paginated history. A dedicated prompt produced two commentary messages separated by shell waits.

A read-only probe observed matching `item_completed` records at 2.1 and 16.7 seconds while Desktop still reported the turn as active. The final message arrived at approximately 30.6 seconds. Thread, turn, native item, and admitted user-message IDs matched Desktop history.

The integrated HTTPS probe then used the actual Desktop adapter and a temporary local HTTP server. It observed commentary at approximately 4.3 and 12.0 seconds, followed by the durable terminal result. Retrying the POST returned the same stored result and left exactly one request receipt. No Sendblue output was sent by this probe.

Local evidence files:

- `/tmp/router-commentary-live-result.json`
- `/tmp/router-live-https-report.json`

These probes establish this installed macOS path. They do not qualify every Desktop version or history mode.

## Automated checks

That earlier build and all 233 TypeScript tests pass, with no failures or skips. Tests cover existing Sendblue behavior plus optional configuration, migration, request authentication, duplicate races, source ordering, recovery, capacity, corrupted state, and SSE.

Injected terminal persistence failure emits no successful terminal event. Restart restores the accepted work without another admission. Blocked and retrying processing remains visible to clients.

The ESP32 parser/receiver compiles on the host with warnings as errors, AddressSanitizer, and UndefinedBehaviorSanitizer. Tests cover fragmented UTF-8, CRLF, resets, reconnects, repeated frame IDs, malformed parts, bounded buffers, and a 256 KiB result.

## Retained-state stress

The probe used real local HTTP, durable filesystem writes, 1024 retained records, four maximum-size prompts and results, and 20 concurrent retries. Execution was synthetic; this test does not measure model throughput.

At the proposed 32 MiB retained-state default, a 31.7 MB snapshot reached about 1.1 GiB peak RSS. That was rejected as the default.

The implementation now avoids full retained-text copies during scheduling and serves committed duplicate submissions without rewriting state. The default retained-record budget is 8 MiB.

At the revised default:

| Measurement | Result |
| --- | --- |
| Retained records | 1024 |
| Encoded snapshot | 7,687,614 bytes |
| Maximum-size requests admitted | 4 of 4 |
| New request at count capacity | 429 |
| Matching retries at capacity | All 202 |
| Twenty concurrent retries | About 137 ms |
| Total measured admission/completion/retry phase | About 793 ms |
| Peak process RSS | About 336 MiB |

The two runs used different retained-result sizes to exercise their respective byte budgets. These are local measurements, not latency or memory guarantees. The budget bounds retained records, not the process heap or existing Sendblue state.

Evidence: `/tmp/router-retention-stress-report.json` and `/tmp/router-retention-stress3.log`.

## Earlier public deployment probe

HTTPS account `local-clients` is enabled in `~/.codex-router/config.toml` and bound to route `sendblue-test`. Its generated bearer token is stored directly in the owner-only configuration file. Sendblue remains configured on the same route.

The public HTTPS probe passed readiness (200), unauthenticated rejection (401), submission (202), final-result retrieval, and duplicate submission with exactly one receipt. The real Desktop turn returned `LIVE_HTTPS_OK`.

Public streaming failed qualification: commentary arrived after about 27.5 seconds, near completion, and no heartbeat reached the client. The existing `trycloudflare.com` Quick Tunnel buffers the stream. [Cloudflare documents that Quick Tunnels do not support SSE](https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/do-more-with-tunnels/trycloudflare/). This public deployment has been retired. Native LAN TLS now passes commentary and heartbeat verification without that tunnel.

Evidence: `/tmp/router-live-deployment-verification.json`. Its overall `passed` value is false because streaming did not pass.

## Remaining qualification

- Public access is intentionally disabled. Native LAN TLS/SSE passed from an isolated Linux client; physical ESP32 qualification remains open.
- ESP-IDF application compilation, Wi-Fi, NVS, TLS, and physical ESP32 operation remain unverified. The toolchain and device were unavailable.
- This version passed Linux container tests. Windows Desktop and a separate physical LAN device remain unqualified.
- The previously reproduced silent connection after daemon termination remains a separate transport limitation.

## Active-turn steering update

On September 27, all 272 macOS tests passed after the steering change. Follow-ups bypass batching and connector barriers during active turns. Tests cover both connector orders, duplicate requests, shared results, and unsupported connections that report blocked status.

A real Desktop probe accepted a follow-up into the existing turn and changed its final answer. Recovery recognized the saved steering UUID without another admission. Desktop recovery uses the accepted steering record and its matching server marker.

The local service restart preserved all 14 existing receipts and resumed the polling checkpoint. The HTTPS live probe admitted its follow-up before the first response, into the same turn, in approximately 1.0 second.

Evidence: `/tmp/router-steering-full.log` and `/tmp/router-https-steer-result.json`. This update has not been retested on Windows or Linux.
