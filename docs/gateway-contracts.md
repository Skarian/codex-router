# Gateway technical contracts

Read [Gateway setup and recovery](gateway.md) for the ordinary message flow. This reference defines state, HTTP, and recovery contracts.

## 1. Detailed message contract

### Inbound events

For each webhook:

1. Enforce the 256 KiB raw-body limit.
2. Authenticate the raw request before JSON parsing.
3. Match exactly one static route.
4. Deduplicate by connector account and full `message_handle`.
5. Append the event to the open batch.
6. Store its compact identity and receipt sequence.
7. Store the snapshot.
8. Return 2xx after durable success.

Ignore outbound events and events without inbound `RECEIVED` status. Do not infer multipart groups from numeric handle suffixes.

Order events by provider time and then durable receipt sequence. Persist the quiet deadline and maximum deadline for each open batch.

### Codex admission and response ownership

Persist the batch ID, client message ID, publication ID, and expected turn ID before each start or steer.

While the owned turn is active, steer each prepared batch immediately. Serialize admissions within the session.

Move the batch from the queue into `CodexWork.batches` in the same transaction that stores its admission intent.

The first accepted batch owns the response. Add later accepted batches to `joinedBatchIds`.

When terminal observation arrives, stop new admissions. Preserve `pendingAdmission` until its result is definite or an operator resolves it.

Correlate each uncertain admission by its client message ID. An existing turn ID alone does not prove acceptance of another batch.

If acceptance is uncertain, keep the route blocked. Do not freeze a delivery or send the input again.

If a steer receives a definite stale-turn rejection, return its batch to the queue. Preserve the previous response owner.

Retain structured RPC errors for rejection classification. Do not infer a stale turn from a transport failure.

After the previous delivery ends, admit that batch against fresh thread state. This is a new admission after a proven rejection.

If no earlier batch owns a response, remove the empty Codex work. Admit the queued batch against fresh thread state.

For another definite admission rejection, clear the intent and set `admissionFailed`. Use the same failure response rules as operator resolution.

After acceptance, store the owning turn ID before clearing the intent. Include the batch in the shared response.

Before delivery preparation, require a terminal turn and no pending admission. Reconstruct terminal output from that exact turn after reconnect.

New batches can arrive while delivery is blocked. Do not admit another Codex turn until the delivery gets a terminal state.

### Recipient parts

Prepare output in this order:

1. Collect stable artifacts into the local spool.
2. Remove duplicate artifacts by content hash.
3. Upload eligible artifacts to Sendblue.
4. Add filename-specific notices for omitted artifacts.
5. Split the final text into parts below the 18,996-character Sendblue limit.
6. Store the frozen delivery, including each uploaded `media_url`.

Uploads are preparation requests. No recipient-message request starts before the frozen delivery snapshot succeeds.

Keep Codex work and its file references until that snapshot succeeds. A restart before freezing can repeat preparation and uploads.

After freezing, use the stored text and media URLs. Do not recollect output, rewrite notices, or upload again.

If a stored URL later fails during message submission, apply the normal message-send rules. Do not change the frozen delivery.

Send text parts first. Then send one media-only part for each artifact. Store each accepted provider handle before the next part.

If one part has uncertain acceptance, stop the route. If Sendblue rejects a part, fail it and skip later ready parts.

### Terminal output

The shared session reports terminal status independently of final text. Native image events remain available for artifact collection.

Use this terminal result inside the shared session:

```ts
interface TurnOutcome {
  turnId: string;
  status: "completed" | "failed" | "interrupted";
  finalText?: string;
  imageGenerations: Array<{
    id: string;
    savedPath?: string;
    result?: string;
  }>;
}
```

Only completed native image items enter `imageGenerations`. Transport errors remain separate from a terminal Codex result.

Use these gateway outcomes:

| Codex outcome | Recipient response |
| --- | --- |
| Completed with text | Final text, omission notices, then available artifacts |
| Completed with artifacts only | Available artifacts, plus text only for omission notices |
| Completed with all artifacts omitted | Filename-specific omission notices |
| Completed without text or artifacts | `Codex finished without a response.` |
| Failed | `Codex could not finish this request.` |
| Interrupted | `Codex stopped before finishing this request.` |

For failed or interrupted turns, send the failure notice. If `admissionFailed` is true, also include the admission notice.

Do not publish partial artifacts or intermediate text.

When delivery ends, release the route. Keep the existing one-shot text and error behavior in `sendTurn()`.

## 2. Configuration contract

Use this V1 TOML shape:

```toml
[gateway]
listen_port = 8787
public_url = "https://example.exe.xyz"
# state_dir = "/absolute/optional/path"

[[gateway.sendblue]]
id = "personal"
api_key_id_env = "SENDBLUE_API_KEY_ID"
api_secret_key_env = "SENDBLUE_API_SECRET_KEY"
webhook_secret_env = "SENDBLUE_WEBHOOK_SECRET"

[[gateway.routes]]
id = "home-messages"
sendblue = "personal"
sender = "+15125550100"
sendblue_number = "+15125550200"
agent = "home"
```

The configuration follows these rules:

- The gateway always binds `127.0.0.1`.
- `listen_port` is required and must be from 1 through 65535.
- `public_url` is an HTTPS origin without a path, query, or fragment.
- If present, `state_dir` must be absolute.
- Sendblue IDs and route IDs use the existing agent-ID format.
- Environment-variable fields contain names instead of secrets.
- `sendblue_number` is the inbound destination and outbound `from_number`.
- `sender` is the only permitted end-user number for the route.
- `sendblue` references one `gateway.sendblue` entry.
- `agent` references one existing agent ID.
- Quiet batching is five seconds and maximum batching is 30 seconds.

The router never changes the account `globalSecret`. The configured signing secret must match that account value.

Existing commands validate the gateway structure. Only `gateway` resolves gateway secrets from the environment.

Validate target uniqueness across resolved routes. Reject two routes that reference the same agent, even through different conversation numbers.

Also reject duplicate configured `thread_id` values. Other Codex clients can still use a routed task.

### Route identity across restarts

Store the resolved route binding before accepting its first event. Compare bindings after loading state and before cleanup or external requests.

The binding fixes the connector ID, normalized numbers, SSH host, task ID, and working directory.

Reject a changed binding or removed route while its state retains work or file references. Report `config_invalid` without changing state.

An unchanged alias does not bypass this comparison. Resolve its target fields before comparison.

Labels, models, reasoning effort, and secret rotation do not change the binding. A connector ID identifies the same provider account across restarts.

If a connector changes accounts, use a new connector ID. Do not retain secret values or hashes in the binding.

For an idle route, permit a binding change after all work and file references end. Keep unexpired deduplication identities.

Each deduplication identity includes the connector ID and full message handle. Compare identities across route records within that connector.

Retain removed idle route records until their identities expire. This prevents a route rename from admitting a recent webhook again.

## 3. Durable state contract

Use one versioned gateway record:

```ts
interface GatewayState {
  version: 1;
  routes: Record<string, RouteState>;
}

interface RouteState {
  binding: RouteBinding;
  nextSequence: number;
  seenMessages: Array<{ sendblueId: string; messageHandle: string; receivedAtMs: number }>;
  openBatch?: Batch;
  queue: Batch[];
  active?: CodexWork | Delivery;
}

interface RouteBinding {
  sendblueId: string;
  sender: string;
  sendblueNumber: string;
  target: {
    sshHost: string | null;
    threadId: string;
    cwd: string;
  };
}

interface Batch {
  id: string;
  openedAtMs: number;
  quietDeadlineMs: number;
  maximumDeadlineMs: number;
  events: InboundEvent[];
}

interface InboundEvent {
  messageHandle: string;
  providerTimeMs: number;
  receiptSequence: number;
  text: string;
  attachment?: InboundAttachment;
}

type InboundAttachment =
  | {
      state: "pending";
      sourceUrl: string;
      name: string;
    }
  | {
      state: "ready";
      name: string;
      mediaType: string;
      inputKind: "image" | "file";
      localPath: string;
      hostPath: string;
    }
  | {
      state: "omitted";
      name: string;
      reason: "download_failed" | "invalid_media" | "copy_failed";
    };

interface CodexWork {
  kind: "codex";
  ownerBatchId: string;
  joinedBatchIds: string[];
  batches: Batch[];
  turnId?: string;
  pendingAdmission?: AdmissionIntent;
  publicationIds: string[];
  artifactBaseline: string[];
  admissionFailed?: true;
}

interface AdmissionIntent {
  batchId: string;
  clientUserMessageId: string;
  publicationId: string;
  expectedTurnId?: string;
}

interface Delivery {
  kind: "delivery";
  id: string;
  batchIds: string[];
  parts: DeliveryPart[];
}

interface DeliveryPart {
  id: string;
  payload:
    | { kind: "text"; text: string }
    | { kind: "media"; localPath: string; name: string; mediaType: string; mediaUrl: string };
  status: "ready" | "sending" | "accepted" | "failed" | "skipped";
  callbackToken?: string;
  providerHandle?: string;
}

type ArtifactOmissionReason =
  | "unsafe_file"
  | "changing_file"
  | "copy_failed"
  | "upload_failed"
  | "connector_limit";
```

Each delivery part uses these transitions:

```text
ready -> sending -> accepted | failed
ready -> skipped
```

A `sending` part contains one callback token. An `accepted` part contains one provider handle. Other states contain neither field.

All automatic attempts in one live operation reuse the callback token. The delivery stores its complete frozen payload.

After attachment preparation, replace `pending` with `ready` or `omitted`. Do not retain the source URL.

The local and host paths are state references for cleanup. The stored binding supplies recipients and the recovery target.

`CodexWork.batches` retains accepted batches and the pending batch. The first admission reserves `ownerBatchId` until acceptance or failure.

`joinedBatchIds` excludes the owner and pending batch. A stale-turn rejection returns its batch to the queue in one transaction.

An operator-failed batch remains referenced until Codex work ends. It is not an accepted joined batch.

`admissionFailed` records the need for one admission notice. It covers definite rejection and operator resolution of uncertain admission.

After `admissionFailed` becomes true, stop further admissions until the owned response ends.

Do not add replacement attempts, retired attempts, attempt expiry, durable retry counters, or durable diagnostic history.

## 4. Attachment preparation

Prepare each pending attachment before Codex admission:

1. Download and validate the provider response.
2. Store and sync the local spool file.
3. Copy the file to the app-server host.
4. Replace `pending` with `ready` after all steps succeed.

A provider download permits two live retries after connection errors, timeouts, HTTP 408, 409, 429, or 5xx.

A remote SSH copy permits two live retries after transport failure. Before retrying a lost response, reconcile the exact final destination.

Do not persist preparation attempt counts. A restart can begin a new preparation operation.

If a provider download, media validation, or host copy fails, store the attachment as `omitted`.

Add a filename-specific omission notice to the Codex input. If the event contains no text, admit the omission notice by itself.

An advertised image that contains another valid file type becomes an ordinary file. It does not become an invalid-media omission.

A local spool write, sync, rename, or state-snapshot failure blocks the route. Do not omit the attachment or admit the batch.

Keep the durable pending state so that restart or operator repair can continue preparation.

A local app-server-host write, sync, or rename failure also blocks the route.

A remote destination mismatch after reconciliation blocks the route. Do not overwrite the destination or omit the attachment.

### File ownership and cleanup

Derive attachment destinations from the route, batch, and full message identity. Use the same destination after a lost response or restart.

Before admission, retain the prepared attachment paths in the batch. After admission begins, retain them in `CodexWork.batches`.

Keep publication directories referenced until the delivery snapshot succeeds. That snapshot transfers ownership to the delivery's local spool paths.

Store each publication ID with its admission intent before creating the directory or sending the mutation.

After a stale-turn rejection, remove that publication reference in the same transaction that restores its batch to the queue.

After a delivery ends, remove its state references before deleting its spool files. Do not prune active file references by age.

Before host cleanup, combine references from every route for that host. Preserve the pending admission's publication directory.

If a live preparation has no final state reference yet, preserve its paths until it ends. Startup has no such live preparation.

Local spool failures during output preparation block the route. Preserve Codex work so that restart can reconstruct its terminal output.

### Native images

Collect native images only from the exact owned turn. Exclude native artifacts present before the first gateway admission.

Capture that baseline once. Do not replace it on later steers or reconnects.

A correlated `imageGeneration.savedPath` permits read-only import of that exact file outside gateway directories.

Require a stable regular file with no symlink traversal. Copy its bytes into the gateway spool before upload.

Never modify or delete a native source outside gateway directories. Do not search its parent directory for other files.

If a native item has no saved path, decode its base64 result into the spool. Apply the same validation and hashing.

If a saved path fails validation or copying, add an omission notice. Do not substitute another source for that item.

## 5. Restart and operator recovery

Startup uses this order:

1. Validate the configuration.
2. Acquire the state lock and load the snapshot.
3. Validate the stored route bindings against the configuration.
4. Remove unreferenced files from local gateway directories.
5. Bind HTTP with readiness false.
6. Accept authenticated status callbacks.
7. Restore batch deadlines and keep persisted `sending` parts blocked.
8. Set readiness true and accept ordinary inbound webhooks.
9. Start route workers independently.

Readiness means that local recovery ended and durable intake is available. It does not require a reachable Codex host.

Before each route resumes Codex work, reconcile its host files. An unavailable host delays only that route's Codex work.

A route can accept queued input during host recovery. A frozen delivery does not require a Codex connection or host cleanup.

Reconcile host files from the combined references before admitting new work on that host. Other hosts remain independent.

After restart, correlate a pending admission before you evaluate its turn. Never claim an unrelated active turn.

If an owned stdio turn is `interrupted`, create one recipient-visible failure delivery. Never send that Codex mutation again.

Provide stopped-gateway commands for these actions:

- List unresolved effects.
- Mark an uncertain Codex admission failed.
- Mark an uncertain Sendblue part accepted with an observed handle.
- Mark an uncertain Sendblue part failed and release the route.

Do not provide an operator retry command in V1.

Shutdown stops intake. It aborts observations, file copies, retry delays, and HTTP requests. It never calls `turn/interrupt`.

## 6. Sendblue request and callback rules

### Request deadlines

Use these limits for each physical request:

- A message-send attempt has a 60-second deadline.
- A typing request has a 60-second deadline and never blocks route progress.
- A media-upload attempt has a ten-minute deadline.
- An inbound download has 60 seconds to receive response headers.
- An inbound download body has a 60-second inactivity deadline.

Reset the download inactivity deadline after each body chunk. Each retry gets new request deadlines.

The HTTP server permits 30 seconds for request headers. It permits 60 seconds of inactivity while reading a POST body.

All webhook and callback bodies have a 256 KiB raw-body limit.

All timers are abortable and do not keep the process alive. Shutdown aborts each active HTTP request.

Do not add a total operation deadline. Do not add deadlines to Codex work, local streams, SSH streams, queued batches, or blocked routes.

### Message-send retries

One live message operation permits no more than two retries after these results:

- A connection error.
- HTTP 408, 409, 429, or 5xx.
- `x-should-retry: true`.

Do not retry after `x-should-retry: false`. Honor valid `Retry-After` and `retry-after-ms` values.

Before each physical message request, acquire the shared line limiter. It permits ten request starts per rolling second for each normalized `from_number`.

If a request returns 2xx with a handle, accept the part. If the first result is a definite rejection, fail the part.

After a retryable or ambiguous result, a later rejection cannot prove that the first request failed. Without an accepted handle, leave the part as `sending`.

A restart never resumes the live request operation. Live retries can cause a duplicate message after response loss. V1 accepts this risk.

Track a live send only in memory:

```ts
interface LiveSend {
  attemptsStarted: number;
  abort: AbortController;
  settlement?:
    | { status: "accepted"; providerHandle: string }
    | { status: "failed" };
}
```

Increment `attemptsStarted` immediately before each physical request.

After each limiter wait, validate the part status, abort signal, and `settlement`. Do not start a request after settlement begins.

Validate eligibility, increment the counter, and start the request without an intervening `await`.

### Upload retries

Media upload uses the same retry classes and permits two live retries. Do not store upload attempts.

A duplicate unused CDN upload cannot duplicate a recipient message.

Before upload, read the stable artifact size. If it exceeds 100,000,000 bytes, omit it with a filename-specific connector-limit notice.

Do not start an upload for an oversized artifact. Exactly 100,000,000 bytes remains eligible.

This limit applies only to outbound Sendblue artifacts. It does not limit inbound attachments, local transfers, or SSH transfers.

### Callback settlement

A positive callback with a handle accepts the current part, including after a retry.

These positive statuses accept a part: `REGISTERED`, `PENDING`, `QUEUED`, `ACCEPTED`, `SENT`, and `DELIVERED`.

`DECLINED` or `ERROR` fails the part only while its live operation exists and `attemptsStarted` is one.

After a retry starts, a negative callback returns 204 without settling the part. It can write only a protected runtime diagnostic.

If no live operation exists, a negative callback also returns 204 without settlement. This rule includes callbacks after restart.

A positive callback can settle a persisted `sending` part after restart. A persisted `sending` part never starts another request automatically.

Validate the account signing header before you parse the body. For a current part, require the exact header value and callback token.

If the delivery or part is no longer current, return 204 without a state change. If the current token is incorrect, reject the request.

Only a `sending` part requires its current token. For accepted, failed, or skipped parts, return 204 after account authentication.

If a callback settles the part, store the result before you return 2xx. If storage fails, return 503.

### Settlement and live request ordering

Use the same settlement path for HTTP results and callbacks. Accept settlement only for the current `sending` part.

Select and store `settlement` without an intervening `await`. Evaluate negative-callback eligibility in that same synchronous step.

Then abort retry delays, limiter waits, and active HTTP requests. Store the selected result through the transaction queue.

Before starting the next part, require durable settlement and completion of the aborted live operation.

Late HTTP results cannot replace a selected result. Duplicate callbacks wait for the selected durable write before returning success.

If storage fails, keep the part blocked and stop automatic requests. A subsequent callback can retry the durable settlement.

Do not discard an accepted handle after a failed snapshot write. Retain it in memory until settlement succeeds or shutdown occurs.

A crash leaves the persisted part as `sending`. Restart never resumes its requests.

An abort cannot undo a request that already reached Sendblue. The accepted duplicate-message risk still applies.

An unknown status does not settle the part. Sendblue documents three webhook retries and a 45-second response window.

## 7. CLI contract

Add only these commands:

```text
codex-router [--config PATH] gateway
codex-router [--config PATH] gateway status [--json]
codex-router [--config PATH] gateway resolve ROUTE_ID EFFECT_ID failed [--json]
codex-router [--config PATH] gateway resolve ROUTE_ID EFFECT_ID accepted HANDLE [--json]
```

`gateway` runs in the foreground. Do not add start, stop, daemon, restart, or gateway-specific doctor commands.

`gateway status` and `gateway resolve` acquire the state lock. They fail while the gateway runs.

Use the client message ID as a Codex effect ID. Use the delivery-part ID as a Sendblue effect ID.

The `failed` resolution applies to an uncertain Codex admission or Sendblue part. The `accepted` resolution applies only to a Sendblue part.

When a Codex admission resolves as failed, clear its intent and set `admissionFailed` in one transaction.

If no accepted turn exists, create one failure delivery. Otherwise, preserve the owned turn and its file references until terminal observation.

Add this notice to its terminal response: `Codex did not confirm the latest input. It was not sent again.`

If no accepted turn exists, use that notice as the entire failure delivery.

Do not interrupt the owned turn or admit another turn during this recovery.

When a Sendblue part resolves as accepted, store the handle. On restart, continue with later ready parts.

When a Sendblue part resolves as failed, skip later ready parts.

Use this JSON status shape:

```json
{
  "unresolved": [
    {
      "routeId": "home-messages",
      "effectId": "part-uuid",
      "kind": "send"
    }
  ]
}
```

`gateway status` fails with `gateway_running` while the foreground gateway owns the lock. Use the health endpoints for live status.

The `kind` value is `codex_admission` or `send`.

Use this JSON resolution shape:

```json
{
  "type": "resolved",
  "routeId": "home-messages",
  "effectId": "part-uuid",
  "resolution": "failed"
}
```

An accepted Sendblue resolution also contains `providerHandle`.

Keep the existing exit rules. Success uses 0, invalid command use uses 2, and operational failure uses 1.

Add `gateway_running` and `effect_not_found` as operational failure codes.

## 8. HTTP contract

All POST responses have an empty body.

### Inbound webhook

`POST /webhooks/sendblue/<sendblue-id>` returns these statuses:

- 204 for an accepted, duplicate, or intentionally ignored event.
- 400 for malformed authenticated JSON or invalid documented fields.
- 401 for a missing or incorrect signing secret.
- 404 for an unknown Sendblue ID or path.
- 413 for a body larger than 256 KiB.
- 415 for a non-JSON content type.
- 503 for unavailable readiness or durable-storage failure.

Return 204 without state changes for authenticated outbound events, groups, unknown senders, and unmatched numbers.

### Status callback

`POST /callbacks/sendblue/<sendblue-id>/<part-id>/<token>` returns these statuses:

- 204 for settlement, duplicate, stale part, unknown status, or a non-settling negative callback.
- 400 for malformed authenticated JSON or invalid documented fields.
- 401 for a missing or incorrect signing secret.
- 401 for an incorrect token on a current part.
- 404 for an unknown Sendblue ID or path.
- 413 for a body larger than 256 KiB.
- 415 for a non-JSON content type.
- 503 for a required durable-write failure.

Validate the signing header before parsing the body. After valid account authentication, a stale part returns 204.

### Health

`GET /healthz` returns 200 with `{"ok":true}` after the HTTP server binds.

After local startup recovery, `GET /readyz` returns 200 with `{"ready":true}`. Before that point, it returns 503 with `{"ready":false}`.

Host recovery and uncertain route effects do not change global readiness. Shutdown sets readiness false before stopping intake.

Other methods return 405. Other paths return 404.

## 9. Security and privacy rules

Authenticate a webhook from its raw body before JSON parsing. Match exactly one static route after authentication.

Use constant-time comparison for `sb-signing-secret`. Use an unguessable token in every status callback URL.

Never log these values:

- Secrets or callback tokens.
- Request bodies or message content.
- Phone numbers or media URLs.
- Prompts or artifact paths.
- Attachment bytes.

Reject directories, symlinks, changing files, and unsafe names.

An unavailable or unsafe publication directory adds an omission notice. Valid text and native artifacts remain eligible.

Publication discovery stays inside gateway-owned directories. The exact native-image import in section 4 is the only outside-file exception.

## 10. Implementation proof matrix

Use deterministic tests for state transitions, timers, and injected failures. Use live probes for provider payloads and platform behavior.

Release validation must prove these contracts. Historical probes provide context, not current release evidence.

### Core and durable state

- Crash before and after each durable admission boundary.
- Restart with each active state and each blocked state.
- Validate every TOML reference, identifier, URL, port, phone number, and environment-variable name.
- Validate each gateway command, JSON result, exit code, stale identity, and running-lock rejection.
- Validate no replay after accepted or uncertain Codex admission.
- Validate a new admission only after a proven stale-turn rejection.
- Validate one response owner per shared turn.
- Validate that one blocked route does not block another route.
- Change each binding field with pending work and validate rejection before cleanup or network requests.
- Rename an idle route and replay a recent webhook. Validate deduplication across the retained route records.
- Point two routes at one agent alias and validate configuration rejection.
- Hold one SSH recovery indefinitely. Validate readiness, durable intake, and delivery on a healthy route.
- Race completion against steer success, stale-turn rejection, acknowledgement loss, and disconnect.
- Restart with a completed turn and pending steer. Validate client-message correlation before delivery creation.
- Resolve a pending steer as failed while its owned turn continues. Validate one response and retained files.

### Local and SSH paths

- Validate local proxy, local owned stdio, and SSH proxy behavior.
- Transfer text, images, ordinary files, zero-byte files, and large files.
- Inject SSH disconnects, truncation, lost responses, metadata changes, and restarts.
- Validate attachment omission after exhausted download, validation, and remote-copy errors.
- Validate that local spool and snapshot errors block admission instead of creating omissions.
- Validate the supported local and SSH client environments.
- Restart during a live proxy turn with prepared input files. Validate that local and host cleanup preserve those files.
- Share a host across routes. Validate that cleanup preserves every route's references.
- Crash before and after the delivery snapshot. Validate publication retention and transfer of spool ownership.
- Validate native images inside and outside publication directories. Preserve all outside source files.
- Restart after native-image completion. Validate exact-turn reconstruction and the original artifact baseline.
- Validate text-only, artifact-only, empty, failed, interrupted, and all-artifacts-omitted terminal output.
- Validate streamed multipart uploads on the minimum supported Node version. Pin compatible dependency versions.

### Sendblue paths

- Capture authenticated text, image, file, two-photo, retry, and callback payloads.
- Validate the configured `sb-signing-secret` on inbound and status callbacks.
- Validate five-second quiet batching and the 30-second maximum.
- Validate typing during batching and useful work.
- Validate every HTTP status and body limit in section 8.
- Validate message, typing, upload, header, and body-inactivity deadlines.
- Drop a response after provider acceptance and record each physical request.
- Race each callback status against retry delays, active requests, and late errors.
- Validate that a negative callback cannot reject a logical send after a retry.
- Validate that a negative callback cannot settle a persisted part after restart.
- Validate that a positive callback can settle a persisted part after restart.
- Validate same-number pacing across concurrent routes.
- Settle a callback during a limiter wait. Validate that no later retry starts.
- Race a negative callback's snapshot write against the second attempt. Validate one ordered settlement decision.
- Fail a settlement snapshot after an accepted handle. Validate no automatic resend and successful durable settlement on callback retry.
- Settle a callback during an active retry. Validate operation completion before the next part starts.
- Fail the second artifact upload. Validate its notice in the frozen text before the first recipient request.
- Restart after uploads but before freezing. Validate safe repeated uploads without recipient messages.
- Restart after freezing. Validate reuse of stored text, part order, and media URLs.
- Validate five-minute typing renewal and explicit stop on the release line. Record firmware-dependent failures.
- Validate operator resolution of uncertain delivery.
- Capture a live two-photo message and validate whether Sendblue emits two independent events.

Before release, validate client-message correlation and native-image recovery on each supported Codex build.

If a required capability is absent, stop release validation. Do not substitute an unsafe admission or artifact-recovery rule.

### Test-resource safety

Before live tests:

1. Record the existing EXE.dev VM inventory and Sendblue webhook.
2. Assign one random test nonce.
3. Record each new VM, task, key, and gateway-owned path.

After live tests:

1. Restore and validate the previous Sendblue webhook.
2. Remove copied credentials and temporary keys.
3. Delete only resources that contain the current nonce.
4. Compare the final inventories with the initial inventories.

Never delete a pre-existing VM, task, credential, or path. If an identity is uncertain, leave the resource unchanged and report it.

## 11. V1 limits

V1 does not include these features:

- Dynamic route pairing or group messages.
- Inbound messaging commands for cancel, status, or new tasks.
- Carousels or Sendblue-specific presentation branches.
- An operator retry command.
- A database, connector registry, remote helper, or cleanup service.

The code keeps one narrow connector boundary for later connectors. It does not add a registry before a second connector exists.

## 12. Primary references

- [Codex app-server README](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md).
- [Sendblue webhooks](https://docs.sendblue.com/getting-started/webhooks/).
- [Sendblue security](https://docs.sendblue.com/security/).
- [Sendblue status callbacks](https://docs.sendblue.com/getting-started/sending-messages/#status-callback).
- [Sendblue send-message](https://docs.sendblue.com/api/resources/messages/methods/send/).
- [Sendblue media upload](https://docs.sendblue.com/api-v2/media/).
- [Sendblue typing](https://docs.sendblue.com/api-v2/typing-indicators).
- [Sendblue limits](https://docs.sendblue.com/limits/).
- [Sendblue TypeScript SDK](https://docs.sendblue.com/api/typescript/).
- [file-type](https://github.com/sindresorhus/file-type).
- [Valibot](https://github.com/open-circle/valibot).
- [Node `fs.openAsBlob()`](https://nodejs.org/api/fs.html#fsopenasblobpath-options).
- [EXE.dev HTTPS gateway](https://exe.dev/docs/proxy).

