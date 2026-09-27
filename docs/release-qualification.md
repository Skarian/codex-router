# Release qualification

Date: 2026-09-27. This record covers the gateway implementation and its final cleanup.

## Intended use

The gateway and router CLI select the current execution owner. Desktop-owned chats use Desktop IPC.

On Linux, an interactive Codex CLI can share a persistent app-server with the router. The tested explicit connection uses `codex --remote unix://`.

Independent `codex exec` ownership is outside this qualification scope. The router does not transfer a chat from that private owner.

## Desktop steering correction

Desktop can accept steering while a tool is still running. Its server message ID and consumption marker appear later.

The adapter now separates acceptance from output attribution. An exact, accepted client message ID and matching turn prove acceptance.

Output still requires the matching server marker. Duplicate records remain errors. Recovery does not resend accepted input.

The change adds no service, state schema, retry policy, or turn timeout.

## Previous completed gates

Before this steering correction, all 310 tests passed on both macOS and Linux. Windows passed 20 targeted native tests.

Windows also passed actual CLI and HTTPS requests, SSE commentary, duplicate handling, authentication, and retained results after gateway restart.

Three additional Windows six-process contention runs each admitted one writer. Every competing process received the expected busy error.

The Mac gateway restart preserved 24 receipts. Verified TLS health, readiness, status, and single-writer checks passed without stopping Desktop.

A real Linux shared-daemon TUI accepted steering through the production router send implementation. History contained exactly one completed turn.

That probe used a Node wrapper. It did not qualify executable argument parsing or HTTPS delivery for that case.

## Steering correction verification

All 317 tests pass on macOS and Linux after the steering correction.

Both new delayed-consumption regression cases fail against an isolated copy of the old correlation code.

Actual Windows CLI steering now succeeds for both callers. CLI cancellation also returns the confirmed interruption.

All 29 focused Desktop tests also pass natively on Windows.

In the controlled Windows probe, the consumption marker arrived 30.3 seconds after acknowledgement. Both original and steering observers completed correctly.

The actual router CLI executable steered a real shared-daemon TUI turn. The active turn ID and history count remained unchanged.

Actual CLI cancellation also passed. Native history confirmed interruption without a final assistant response.

HTTPS also steered the active TUI turn through the shared daemon. The request entered running state with no queued batch.

After an SSE disconnect and forced gateway restart, an identical POST recovered the original turn and final result.

The reconnected stream returned a reset, completed status, commentary, and terminal response. The thread turn count did not increase.

The Mac gateway now runs this correction. Its restart preserved all 24 receipts, and polling, status, and verified TLS health checks pass.

## Final cleanup verification

The cleanup removes duplicate command wrappers, version-1 state migration, and unused types. Command tests now use the production command layer.

All 318 tests pass on macOS after this cleanup. Windows and Linux were not rerun for these changes.

The live Mac gateway runs the cleanup build. Its restart preserved all 25 receipts and left the configuration unchanged.

Polling, diagnostics, and TLS health and readiness checks pass. The Desktop app stayed running.

## Limits

Desktop uses a private, versioned protocol. These results apply to the tested versions, not all future Desktop releases.

Gateway shutdown sends no explicit cancellation. Losing an owned stdio app-server can interrupt its turn; recovery does not resend it.

Process-crash recovery does not establish power-loss durability. Physical ESP32 TLS and firmware behavior remain unverified.

## Earlier connector and stress evidence

Earlier live SendBlue probes delivered text and images and completed read-receipt and typing API calls in poll mode.
Those probes did not require a public receiver. They are not fresh provider tests for the final cleanup.

A polling stress probe recovered 1,000 messages after a page failure. Restart and overlap replay produced one receipt per message.
Another probe recovered a row skipped by mutable offset pagination during its first sweep.

A retained-state stress probe stored 1,024 records within the 8 MiB record budget.
New admission returned `429` at capacity, while matching retries remained available.
These measurements are not throughput or process-memory guarantees.

A Linux client reached the Mac LAN endpoint with verified TLS. Wrong tokens, untrusted certificates, and incorrect hostnames were rejected.
The retired public Quick Tunnel buffered SSE. Native LAN TLS passed commentary, heartbeat, and reconnect probes.

ESP32 host parser tests passed with AddressSanitizer and UndefinedBehaviorSanitizer.
They covered byte splits, CRLF, reconnect, reset, duplicates, bounded input, and a 256 KiB result.
Physical-device and ESP-IDF firmware qualification remain separate.
