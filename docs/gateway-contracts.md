# Gateway technical contracts

This reference describes the request runtime and connector boundaries. Start with [gateway operation](gateway.md) for procedures.
The current implementation uses one state store and writer. It does not require a database or message broker.

## Ownership and identities

The catalog resolves agent IDs and exposes public labels. Execution sessions discover owners, admit or steer supplied intents, observe output, and interrupt expected turns.
The optional request runtime owns durable intake, execution intents, recovery, results, semantic progress, and delivery jobs.
The gateway hosts that runtime and the connectors. Connectors do not independently submit model turns.

CLI commands use execution sessions directly. They do not open the gateway store or promise crash-resumable request receipts.
The router rejects duplicate execution targets. Backend ownership still governs concurrent independent CLI and Desktop processes.

HTTP uses a shared origin namespace. Its request identity is the agent ID and request UUID.
SendBlue deduplicates by account and complete provider message handle, including after a conversation mapping changes.
A SendBlue conversation identity includes account, sender, and receiving line.
Origins identify work and destinations. They are not authentication accounts.

Intake freezes the selected target and reply destination. Pending work prevents incompatible rebinding or removal.
External authentication grants shared access to all HTTP agents and retained API requests.

## Durable intake and admission

The state format is version 3. Intake commits its receipt and reservations before reporting success.
Matching retries reuse existing receipts. A changed HTTP payload with the same request UUID returns a conflict.

Idle SendBlue input uses a quiet interval and maximum batching deadline. HTTP input has no quiet interval.
Active-turn input steers without waiting for ordinary completion.
Preparation remains ordered within an origin. Ready input from another origin can proceed during slow attachment preparation.

Before admission, the runtime stores the exact message UUID, expected turn, execution binding, and publication references.
Only then does it call the execution session. Confirmed admission stores the turn ID and clears its pending intent.
An earlier turn ID does not prove acceptance of a later steering message.

An uncertain acknowledgement triggers correlation of the stored UUID, not another submission.
Unresolved admission prevents final attribution until recovery or operator resolution establishes its outcome.
A definite stale-turn rejection permits admission against fresh thread state. Transport failure is not a definite rejection.

Desktop acceptance and output attribution use separate evidence. Recovery preserves the original execution binding and waits for a compatible owner.

## Progress and cancellation

The runtime publishes bounded semantic status, reasoning summaries, commentary, terminal results, and replay resets.
Only backend-published summaries are available. Progress does not expose raw model internals or synchronize full chat history.
A connector can consume these events without an HTTP listener.

HTTP formats SSE frames and handles cursors, heartbeats, quotas, and slow connections.
The semantic buffer permits 16 MiB globally and 128 subscriptions. Each request permits 2 MiB or 128 messages.
HTTP frame indexes have a separate 2 MiB budget. They retain slice boundaries rather than escaped message copies.

Terminal publication follows durable result storage. Temporary progress can disappear after restart or eviction.
Observer errors do not invalidate execution. Stream disconnection does not cancel a turn.

Cancellation identifies an expected turn. It requests interruption without waiting for completion or provider delivery.
A stale identity cannot cancel a successor. An uncertain acknowledgement does not trigger automatic retry.
Cancellation does not erase queued input or settle uncertain sends.

## Completion and outbox

After all admissions resolve, the runtime stages eligible output files without provider uploads.
Files become immutable local references. The runtime syncs them before the completion transaction.

One transaction commits the canonical result and destination delivery jobs, then releases the execution slot.
Only after that transaction does terminal progress appear.
The next execution can start while a provider upload or delivery remains pending.

A crash before commit leaves recoverable execution and possible unreferenced staging files.
A crash after commit leaves durable results and pinned artifact references.
Cleanup removes only unreferenced files. Pending delivery pins its result and artifacts beyond ordinary result expiry.

Delivery order is per conversation, including after a conversation selects another agent.
An uncertain send blocks later deliveries to that destination. It does not block HTTP results or unrelated execution.

## Provider effects

Delivery workers upload staged files and freeze formatted text, order, and media URLs before sending messages.
Text precedes media. Each part stores `sending` before the physical request.

```text
ready -> sending -> accepted | failed
ready -> skipped
```

Accepted parts retain provider handles. Sending parts retain callback tokens.
Automatic retries require definite retryable rejection. There are at most two retries after the first attempt.
Lost responses and unusable acknowledgements remain uncertain. Restart never automatically resends stored `sending` parts.
A failed part skips later ready parts.

Positive authenticated callbacks can settle webhook deliveries. Negative callbacks cannot prove rejection after multiple physical attempts.
Polling accounts expose no webhook or callback handler.
Provider SDK retries remain disabled. Shared per-line scheduling limits recipient effects.
Typing and read-receipt errors remain nonfatal.

## Capacity and files

Intake reserves request and delivery metadata before acceptance. Duplicate lookups do not consume another reservation.
Each accepted provider-bound batch reserves capacity. Shared completions release surplus reservations.
Receipts reference one canonical completion, which stores the response, turn ID, and expiry.
Pending delivery retains an expired completion without extending request visibility.
The outbox permits 128 jobs or reservations globally and 32 per destination.

Artifacts are best effort. A completion permits 16 files and 100,000,000 bytes in total.
The shared spool permits 512 MiB, including temporary and pinned files. Staging has a 60-second deadline.
Size, count, deadline, or capacity exclusions produce explicit omission notices.
Storage or sync failures leave work recoverable instead of pretending successful delivery.

Safe copying rejects symlinks, directories, and files that change during copying.
Cleanup preserves pending admission, active execution, and outbox references.
Native images must belong to the observed turn. Native files outside managed directories remain unchanged.

Polling checkpoints advance only after accepted input. Capacity rejection can pause other conversations within the same SendBlue account.
HTTP intake remains independent. No checkpoint skips an unaccepted provider message.

## Storage and recovery

One process holds the [operating-system lock](gateway-lock.md). One serialized writer replaces the canonical snapshot atomically.
A failure after replacement poisons the writer rather than permitting further uncertain writes.
Diagnostics use a separate disposable snapshot and do not change canonical state.

Manual resolution and polling reset require a stopped gateway and its state lock.
The gateway rejects unsupported state formats without rewriting them.

Shutdown stops intake and local work without explicit turn cancellation.
Loss of an owned stdio server can interrupt its turn. Recovery does not resend uncertain input.

See [test installation replacement](gateway.md#replace-a-test-installation), [SendBlue recovery](sendblue.md#polling-recovery), and [HTTP contracts](https.md).
