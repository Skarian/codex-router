# Gateway technical contracts

This reference describes the implemented boundaries. Start with [gateway operation](gateway.md) for setup and recovery procedures.
The [state schemas](https://github.com/Skarian/codex-router/blob/main/src/gateway-state.ts) define persisted records and validation.

## Sources and routes

Each route binds source identities to one execution target: host, chat ID, and working directory.
SendBlue identities include the account, sender, and receiving line. HTTPS identities include the account and route.
Credentials do not enter these bindings.

A route can accept both connectors. One execution target cannot appear in competing routes.
Pending work prevents changes to its source identity or target.
Credential rotation does not change identity when the account ID stays the same.

SendBlue deduplicates by account and complete provider message handle across route records.
HTTPS deduplicates by account, route, request ID, and payload identity.
A reused HTTPS request ID with different text returns `409`.

## Durable intake and admission

Input becomes durable before intake reports success. The snapshot stores batches, receipts, source identities, and polling checkpoints.
The current state format is version 2. Version-1 migration is not supported.

Idle SendBlue input uses a quiet batching interval with a maximum deadline.
HTTPS input uses immediate batching. During an active turn, follow-ups bypass the quiet interval.
Admissions remain serialized within the execution session.

Before a start or steer, the gateway stores the client message UUID, expected turn, execution binding, and publication references.
After confirmed admission, it stores the turn ID and clears the pending intent.
An existing turn ID does not prove acceptance of a later steering message.

An uncertain acknowledgement triggers UUID correlation, not another submission.
Unresolved admission blocks completion until correlation or operator resolution establishes its outcome.
A definite stale-turn rejection returns its batch for admission against fresh thread state.
Transport failure is not a definite rejection.

Desktop acceptance and output attribution are separate boundaries.
An exact accepted steering record proves admission. Output still requires its matching consumption marker.
Recovery of Desktop-admitted work waits for Desktop ownership.

## Completion and progress

Each participating source prepares its completion plan after the shared turn ends and pending admissions resolve.
HTTPS retains the terminal result. SendBlue prepares one ordered delivery for its participating messages.

The gateway stores the result before publishing a terminal SSE event.
Commentary represents completed semantic messages, not individual tokens.
Temporary commentary history is bounded and can disappear after restart or eviction.
Durable HTTPS results remain retrievable for their retention period.

See [HTTPS contracts](https.md) for authentication, reservations, SSE frames, cursors, and capacity limits.
Connector results are not a synchronized transcript of all activity in the Codex chat.

## SendBlue output

The gateway collects stable artifacts, removes duplicates by content hash, and uploads eligible files before recipient delivery.
It adds omission notices and splits text into parts below the provider text limit.
Then it stores the complete delivery, including uploaded media URLs.

No recipient request starts before that snapshot succeeds.
A restart before this point can repeat preparation or uploads. A restart afterward uses the frozen text, order, and URLs.
Text parts precede media parts. Each accepted part stores its provider handle before the next part starts.

```text
ready -> sending -> accepted | failed
ready -> skipped
```

A `sending` part contains a callback token. An `accepted` part contains a provider handle.
Other part states contain neither field.

Automatic retries require a definite retryable rejection. There are at most two retries after the first request.
Lost responses, server errors, and unusable success responses remain uncertain.
A stored `sending` part is never automatically resent after restart.
A failed part skips later ready parts. An uncertain part blocks its route.

Webhook mode can settle accepted delivery through a positive authenticated callback.
A negative callback cannot prove rejection after multiple physical attempts.
Polling mode sends no callback URL and exposes no callback handler.
SDK implicit retries are disabled. The router owns retry and per-line request scheduling.
Typing and read-receipt failures remain nonfatal.

## Files

Inbound preparation changes an attachment from `pending` to `ready` or `omitted`.
Ready files retain local and execution-host paths. Prepared records no longer need the provider source URL.
Download or content failures can produce omissions. Local storage failures block progress instead of admitting incomplete state.

The gateway rejects symlinks, directories, and files that change during copying.
Native images must belong to the exact turn. Native source files outside gateway directories remain unchanged.
Cleanup preserves references from active work and pending admissions across routes on the same host.
Frozen delivery retains its local artifacts until delivery releases them.

## Storage and recovery

One process holds the [operating-system lock](gateway-lock.md). One serialized writer replaces the canonical snapshot atomically.
State transitions precede external effects whenever recovery needs their identity.
A failure after snapshot replacement poisons the writer instead of permitting further uncertain writes.

Diagnostics use a separate disposable snapshot. CLI status does not acquire the writer lock.
Manual resolution and polling reset require a stopped gateway and acquire that lock.

Shutdown stops intake and local work without explicitly cancelling the Codex turn.
Loss of an owned stdio server can interrupt its turn. Recovery does not resend the input.

See [SendBlue polling recovery](sendblue.md#polling-recovery) for checkpoint bounds.
See [manual resolution](gateway.md#recover-an-uncertain-operation) for unresolved admissions and deliveries.
See [release qualification](release-qualification.md) for the tested platforms and remaining limits.
