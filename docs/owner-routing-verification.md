# Owner-routing verification

This report records earlier probes. See [release qualification](release-qualification.md) for the current matrix and remaining gates.

September 26, 2026. This is an implementation test record, not a full release qualification.

## Completed

- The automated suite covers socket ownership, connection failure, writer conflicts, durable admission, queue order, recovery, output boundaries, file transfer, provider retries, callbacks, and shutdown.
- New restart tests close and reopen the gateway store before restoring work. The admission hook also checks the persisted state file before dispatch.
- The real macOS Desktop adapter recovered an acknowledged turn, a turn with a discarded acknowledgement, and a joined turn. All three returned their exact expected final text. No input was resent.
- A new turn through the adapter returned its exact requested token.
- Sixteen concurrent Desktop follower connections completed 160 history reads without error in approximately 0.6 seconds. This exercises IPC and history reads, not model throughput.
- The test gateway was restarted while Desktop and the tunnel stayed running. It preserved the queued batch, processed it through Desktop, and returned to an empty queue.
- A read-only Sendblue API check confirmed that reply as `DELIVERED` over RCS.

Live checks exposed canonical history outside `snapshot.turns`, a stale optimistic draft after concurrent starts, and a broker error response without a method field. Regression tests cover these formats. Incomplete or conflicting history remains an explicit error.

## Focused recovery fixes

Review reproduced four failure paths with isolated temporary stores and broker/provider fixtures. These checks used the actual gateway, Desktop adapter, and file-plane classes. They did not send real messages or stop Desktop.

- A history failure before dispatch left a pending admission for input that was never sent. The final read-only preflight now runs before publication allocation and admission persistence. Local busy guards remain in the adapter.
- Failed filesystem reconciliation stayed cached across reconnections. Failed entries are now evicted; concurrent callers still share setup, and successful setup remains cached.
- Desktop owner-loss responses stopped the route as protocol failures. The two known availability responses now trigger rediscovery and recovery of the saved message identity. Potentially accepted input is not resubmitted.
- A provider send with no remaining attempt appeared as running. Live status now distinguishes unresolved delivery from an active request.

Targeted checks cover one admission after a preflight failure, recovery without resubmission after owner loss, successful setup on the next connection, and status transitions through uncertain delivery and confirmation. The owner-loss test also exposed an early retry-timer callback that could leave no future retry scheduled. The callback now reschedules the remaining delay, with a deterministic regression test.

## Gates remaining at the time of this report

- Full Desktop quit, relaunch, and crash tests from an independent runner. This conversation's app was not stopped.
- Router-first startup followed by Desktop opening during an owned turn, with eventual writer release verified end to end.
- Real Windows named-pipe ownership checks, storage permissions, local paths, reconnect, and application lifecycle tests. Windows SSH requires a separate shell/file adapter.
- CLI commands do not yet select the Desktop adapter. Their existing direct app-server tests still pass.
- Requalification against future Desktop IPC versions. The adapter uses a private, versioned interface and fails closed on unsupported formats.
- Durable tunnel and service supervision. The current Mac test setup still uses the existing temporary tunnel and manually started gateway.

Do not infer full cross-platform compatibility from the macOS result. A private CLI owner can delay delivery until it releases the task. Already-admitted Desktop work remains tied to Desktop recovery, and a history visibility delay beyond the bounded correlation wait can require operator review.
