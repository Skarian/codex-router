import * as v from "valibot";
import { type GatewayConfig, type GatewayRoute } from "./config.js";
declare const attachmentSchema: v.VariantSchema<"state", [v.StrictObjectSchema<{
    readonly state: v.LiteralSchema<"pending", undefined>;
    readonly sourceUrl: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
}, undefined>, v.StrictObjectSchema<{
    readonly state: v.LiteralSchema<"ready", undefined>;
    readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly mediaType: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly inputKind: v.PicklistSchema<["image", "file"], undefined>;
    readonly localPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly hostPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
}, undefined>, v.StrictObjectSchema<{
    readonly state: v.LiteralSchema<"omitted", undefined>;
    readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly reason: v.PicklistSchema<["download_failed", "invalid_media", "copy_failed"], undefined>;
}, undefined>], undefined>;
declare const eventSchema: v.StrictObjectSchema<{
    readonly messageHandle: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly providerTimeMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
    readonly receiptSequence: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
    readonly text: v.StringSchema<undefined>;
    readonly attachment: v.OptionalSchema<v.VariantSchema<"state", [v.StrictObjectSchema<{
        readonly state: v.LiteralSchema<"pending", undefined>;
        readonly sourceUrl: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    }, undefined>, v.StrictObjectSchema<{
        readonly state: v.LiteralSchema<"ready", undefined>;
        readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly mediaType: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly inputKind: v.PicklistSchema<["image", "file"], undefined>;
        readonly localPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly hostPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    }, undefined>, v.StrictObjectSchema<{
        readonly state: v.LiteralSchema<"omitted", undefined>;
        readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly reason: v.PicklistSchema<["download_failed", "invalid_media", "copy_failed"], undefined>;
    }, undefined>], undefined>, undefined>;
}, undefined>;
declare const batchSchema: v.StrictObjectSchema<{
    readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly sourceId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly openedAtMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
    readonly quietDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
    readonly maximumDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
    readonly events: v.ArraySchema<v.StrictObjectSchema<{
        readonly messageHandle: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly providerTimeMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly receiptSequence: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly text: v.StringSchema<undefined>;
        readonly attachment: v.OptionalSchema<v.VariantSchema<"state", [v.StrictObjectSchema<{
            readonly state: v.LiteralSchema<"pending", undefined>;
            readonly sourceUrl: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        }, undefined>, v.StrictObjectSchema<{
            readonly state: v.LiteralSchema<"ready", undefined>;
            readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly mediaType: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly inputKind: v.PicklistSchema<["image", "file"], undefined>;
            readonly localPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly hostPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        }, undefined>, v.StrictObjectSchema<{
            readonly state: v.LiteralSchema<"omitted", undefined>;
            readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly reason: v.PicklistSchema<["download_failed", "invalid_media", "copy_failed"], undefined>;
        }, undefined>], undefined>, undefined>;
    }, undefined>, undefined>;
}, undefined>;
declare const intentSchema: v.StrictObjectSchema<{
    readonly batchId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly clientUserMessageId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly publicationId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
    readonly expectedTurnId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
}, undefined>;
declare const workSchema: v.StrictObjectSchema<{
    readonly kind: v.LiteralSchema<"codex", undefined>;
    readonly ownerBatchId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly joinedBatchIds: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
    readonly batches: v.ArraySchema<v.StrictObjectSchema<{
        readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly sourceId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly openedAtMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly quietDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly maximumDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly events: v.ArraySchema<v.StrictObjectSchema<{
            readonly messageHandle: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly providerTimeMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly receiptSequence: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly text: v.StringSchema<undefined>;
            readonly attachment: v.OptionalSchema<v.VariantSchema<"state", [v.StrictObjectSchema<{
                readonly state: v.LiteralSchema<"pending", undefined>;
                readonly sourceUrl: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            }, undefined>, v.StrictObjectSchema<{
                readonly state: v.LiteralSchema<"ready", undefined>;
                readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly mediaType: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly inputKind: v.PicklistSchema<["image", "file"], undefined>;
                readonly localPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly hostPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            }, undefined>, v.StrictObjectSchema<{
                readonly state: v.LiteralSchema<"omitted", undefined>;
                readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly reason: v.PicklistSchema<["download_failed", "invalid_media", "copy_failed"], undefined>;
            }, undefined>], undefined>, undefined>;
        }, undefined>, undefined>;
    }, undefined>, undefined>;
    readonly turnId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
    readonly pendingAdmission: v.OptionalSchema<v.StrictObjectSchema<{
        readonly batchId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly clientUserMessageId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly publicationId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        readonly expectedTurnId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
    }, undefined>, undefined>;
    readonly binding: v.OptionalSchema<v.StrictObjectSchema<{
        readonly backend: v.PicklistSchema<["desktop", "proxy", "stdio"], undefined>;
        readonly host: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly codexHome: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly threadId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    }, undefined>, undefined>;
    readonly clientUserMessageId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
    readonly publicationIds: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
    readonly artifactBaseline: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
    readonly admissionFailed: v.OptionalSchema<v.LiteralSchema<true, undefined>, undefined>;
}, undefined>;
declare const partSchema: v.StrictObjectSchema<{
    readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly payload: v.VariantSchema<"kind", [v.StrictObjectSchema<{
        readonly kind: v.LiteralSchema<"text", undefined>;
        readonly text: v.StringSchema<undefined>;
    }, undefined>, v.StrictObjectSchema<{
        readonly kind: v.LiteralSchema<"media", undefined>;
        readonly localPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly mediaType: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly mediaUrl: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    }, undefined>], undefined>;
    readonly status: v.PicklistSchema<["ready", "sending", "accepted", "failed", "skipped"], undefined>;
    readonly callbackToken: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
    readonly providerHandle: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
}, undefined>;
declare const deliverySchema: v.StrictObjectSchema<{
    readonly kind: v.LiteralSchema<"delivery", undefined>;
    readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly sourceId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly batchIds: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
    readonly parts: v.ArraySchema<v.StrictObjectSchema<{
        readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly payload: v.VariantSchema<"kind", [v.StrictObjectSchema<{
            readonly kind: v.LiteralSchema<"text", undefined>;
            readonly text: v.StringSchema<undefined>;
        }, undefined>, v.StrictObjectSchema<{
            readonly kind: v.LiteralSchema<"media", undefined>;
            readonly localPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly mediaType: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly mediaUrl: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        }, undefined>], undefined>;
        readonly status: v.PicklistSchema<["ready", "sending", "accepted", "failed", "skipped"], undefined>;
        readonly callbackToken: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        readonly providerHandle: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
    }, undefined>, undefined>;
}, undefined>;
declare const resultSchema: v.StrictObjectSchema<{
    readonly status: v.PicklistSchema<["completed", "failed", "interrupted"], undefined>;
    readonly text: v.StringSchema<undefined>;
    readonly notices: v.ArraySchema<v.StringSchema<undefined>, undefined>;
}, undefined>;
declare const receiptSchema: v.StrictObjectSchema<{
    readonly sourceId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly externalId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly receivedAtMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
    readonly payloadHash: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
    readonly batchId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
    readonly result: v.OptionalSchema<v.StrictObjectSchema<{
        readonly status: v.PicklistSchema<["completed", "failed", "interrupted"], undefined>;
        readonly text: v.StringSchema<undefined>;
        readonly notices: v.ArraySchema<v.StringSchema<undefined>, undefined>;
    }, undefined>, undefined>;
    readonly expiresAtMs: v.OptionalSchema<v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>, undefined>;
    readonly reservedBytes: v.OptionalSchema<v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>, undefined>;
    readonly turnId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
}, undefined>;
declare const bindingSchema: v.StrictObjectSchema<{
    readonly sources: v.ArraySchema<v.VariantSchema<"kind", [v.StrictObjectSchema<{
        readonly kind: v.LiteralSchema<"sendblue", undefined>;
        readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly accountId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly sender: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly sendblueNumber: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    }, undefined>, v.StrictObjectSchema<{
        readonly kind: v.LiteralSchema<"https", undefined>;
        readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly accountId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    }, undefined>], undefined>, undefined>;
    readonly target: v.StrictObjectSchema<{
        readonly sshHost: v.NullableSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        readonly threadId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly cwd: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    }, undefined>;
}, undefined>;
declare const routeSchema: v.StrictObjectSchema<{
    readonly binding: v.StrictObjectSchema<{
        readonly sources: v.ArraySchema<v.VariantSchema<"kind", [v.StrictObjectSchema<{
            readonly kind: v.LiteralSchema<"sendblue", undefined>;
            readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly accountId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly sender: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly sendblueNumber: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        }, undefined>, v.StrictObjectSchema<{
            readonly kind: v.LiteralSchema<"https", undefined>;
            readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly accountId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        }, undefined>], undefined>, undefined>;
        readonly target: v.StrictObjectSchema<{
            readonly sshHost: v.NullableSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            readonly threadId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly cwd: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        }, undefined>;
    }, undefined>;
    readonly nextSequence: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
    readonly receipts: v.ArraySchema<v.StrictObjectSchema<{
        readonly sourceId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly externalId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly receivedAtMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly payloadHash: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        readonly batchId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        readonly result: v.OptionalSchema<v.StrictObjectSchema<{
            readonly status: v.PicklistSchema<["completed", "failed", "interrupted"], undefined>;
            readonly text: v.StringSchema<undefined>;
            readonly notices: v.ArraySchema<v.StringSchema<undefined>, undefined>;
        }, undefined>, undefined>;
        readonly expiresAtMs: v.OptionalSchema<v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>, undefined>;
        readonly reservedBytes: v.OptionalSchema<v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>, undefined>;
        readonly turnId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
    }, undefined>, undefined>;
    readonly openBatch: v.OptionalSchema<v.StrictObjectSchema<{
        readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly sourceId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly openedAtMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly quietDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly maximumDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly events: v.ArraySchema<v.StrictObjectSchema<{
            readonly messageHandle: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly providerTimeMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly receiptSequence: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly text: v.StringSchema<undefined>;
            readonly attachment: v.OptionalSchema<v.VariantSchema<"state", [v.StrictObjectSchema<{
                readonly state: v.LiteralSchema<"pending", undefined>;
                readonly sourceUrl: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            }, undefined>, v.StrictObjectSchema<{
                readonly state: v.LiteralSchema<"ready", undefined>;
                readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly mediaType: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly inputKind: v.PicklistSchema<["image", "file"], undefined>;
                readonly localPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly hostPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            }, undefined>, v.StrictObjectSchema<{
                readonly state: v.LiteralSchema<"omitted", undefined>;
                readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly reason: v.PicklistSchema<["download_failed", "invalid_media", "copy_failed"], undefined>;
            }, undefined>], undefined>, undefined>;
        }, undefined>, undefined>;
    }, undefined>, undefined>;
    readonly queue: v.ArraySchema<v.StrictObjectSchema<{
        readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly sourceId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly openedAtMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly quietDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly maximumDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly events: v.ArraySchema<v.StrictObjectSchema<{
            readonly messageHandle: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly providerTimeMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly receiptSequence: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly text: v.StringSchema<undefined>;
            readonly attachment: v.OptionalSchema<v.VariantSchema<"state", [v.StrictObjectSchema<{
                readonly state: v.LiteralSchema<"pending", undefined>;
                readonly sourceUrl: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            }, undefined>, v.StrictObjectSchema<{
                readonly state: v.LiteralSchema<"ready", undefined>;
                readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly mediaType: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly inputKind: v.PicklistSchema<["image", "file"], undefined>;
                readonly localPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly hostPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            }, undefined>, v.StrictObjectSchema<{
                readonly state: v.LiteralSchema<"omitted", undefined>;
                readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly reason: v.PicklistSchema<["download_failed", "invalid_media", "copy_failed"], undefined>;
            }, undefined>], undefined>, undefined>;
        }, undefined>, undefined>;
    }, undefined>, undefined>;
    readonly active: v.OptionalSchema<v.VariantSchema<"kind", [v.StrictObjectSchema<{
        readonly kind: v.LiteralSchema<"codex", undefined>;
        readonly ownerBatchId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly joinedBatchIds: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        readonly batches: v.ArraySchema<v.StrictObjectSchema<{
            readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly sourceId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly openedAtMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly quietDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly maximumDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly events: v.ArraySchema<v.StrictObjectSchema<{
                readonly messageHandle: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly providerTimeMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
                readonly receiptSequence: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
                readonly text: v.StringSchema<undefined>;
                readonly attachment: v.OptionalSchema<v.VariantSchema<"state", [v.StrictObjectSchema<{
                    readonly state: v.LiteralSchema<"pending", undefined>;
                    readonly sourceUrl: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                }, undefined>, v.StrictObjectSchema<{
                    readonly state: v.LiteralSchema<"ready", undefined>;
                    readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly mediaType: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly inputKind: v.PicklistSchema<["image", "file"], undefined>;
                    readonly localPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly hostPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                }, undefined>, v.StrictObjectSchema<{
                    readonly state: v.LiteralSchema<"omitted", undefined>;
                    readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly reason: v.PicklistSchema<["download_failed", "invalid_media", "copy_failed"], undefined>;
                }, undefined>], undefined>, undefined>;
            }, undefined>, undefined>;
        }, undefined>, undefined>;
        readonly turnId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        readonly pendingAdmission: v.OptionalSchema<v.StrictObjectSchema<{
            readonly batchId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly clientUserMessageId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly publicationId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            readonly expectedTurnId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        }, undefined>, undefined>;
        readonly binding: v.OptionalSchema<v.StrictObjectSchema<{
            readonly backend: v.PicklistSchema<["desktop", "proxy", "stdio"], undefined>;
            readonly host: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly codexHome: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly threadId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        }, undefined>, undefined>;
        readonly clientUserMessageId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        readonly publicationIds: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        readonly artifactBaseline: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        readonly admissionFailed: v.OptionalSchema<v.LiteralSchema<true, undefined>, undefined>;
    }, undefined>, v.StrictObjectSchema<{
        readonly kind: v.LiteralSchema<"delivery", undefined>;
        readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly sourceId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly batchIds: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        readonly parts: v.ArraySchema<v.StrictObjectSchema<{
            readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly payload: v.VariantSchema<"kind", [v.StrictObjectSchema<{
                readonly kind: v.LiteralSchema<"text", undefined>;
                readonly text: v.StringSchema<undefined>;
            }, undefined>, v.StrictObjectSchema<{
                readonly kind: v.LiteralSchema<"media", undefined>;
                readonly localPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly mediaType: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly mediaUrl: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            }, undefined>], undefined>;
            readonly status: v.PicklistSchema<["ready", "sending", "accepted", "failed", "skipped"], undefined>;
            readonly callbackToken: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            readonly providerHandle: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        }, undefined>, undefined>;
    }, undefined>], undefined>, undefined>;
}, undefined>;
declare const stateSchema: v.StrictObjectSchema<{
    readonly version: v.LiteralSchema<2, undefined>;
    readonly routes: v.RecordSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, v.StrictObjectSchema<{
        readonly binding: v.StrictObjectSchema<{
            readonly sources: v.ArraySchema<v.VariantSchema<"kind", [v.StrictObjectSchema<{
                readonly kind: v.LiteralSchema<"sendblue", undefined>;
                readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly accountId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly sender: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly sendblueNumber: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            }, undefined>, v.StrictObjectSchema<{
                readonly kind: v.LiteralSchema<"https", undefined>;
                readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly accountId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            }, undefined>], undefined>, undefined>;
            readonly target: v.StrictObjectSchema<{
                readonly sshHost: v.NullableSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
                readonly threadId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly cwd: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            }, undefined>;
        }, undefined>;
        readonly nextSequence: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly receipts: v.ArraySchema<v.StrictObjectSchema<{
            readonly sourceId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly externalId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly receivedAtMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly payloadHash: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            readonly batchId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            readonly result: v.OptionalSchema<v.StrictObjectSchema<{
                readonly status: v.PicklistSchema<["completed", "failed", "interrupted"], undefined>;
                readonly text: v.StringSchema<undefined>;
                readonly notices: v.ArraySchema<v.StringSchema<undefined>, undefined>;
            }, undefined>, undefined>;
            readonly expiresAtMs: v.OptionalSchema<v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>, undefined>;
            readonly reservedBytes: v.OptionalSchema<v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>, undefined>;
            readonly turnId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        }, undefined>, undefined>;
        readonly openBatch: v.OptionalSchema<v.StrictObjectSchema<{
            readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly sourceId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly openedAtMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly quietDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly maximumDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly events: v.ArraySchema<v.StrictObjectSchema<{
                readonly messageHandle: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly providerTimeMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
                readonly receiptSequence: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
                readonly text: v.StringSchema<undefined>;
                readonly attachment: v.OptionalSchema<v.VariantSchema<"state", [v.StrictObjectSchema<{
                    readonly state: v.LiteralSchema<"pending", undefined>;
                    readonly sourceUrl: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                }, undefined>, v.StrictObjectSchema<{
                    readonly state: v.LiteralSchema<"ready", undefined>;
                    readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly mediaType: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly inputKind: v.PicklistSchema<["image", "file"], undefined>;
                    readonly localPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly hostPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                }, undefined>, v.StrictObjectSchema<{
                    readonly state: v.LiteralSchema<"omitted", undefined>;
                    readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly reason: v.PicklistSchema<["download_failed", "invalid_media", "copy_failed"], undefined>;
                }, undefined>], undefined>, undefined>;
            }, undefined>, undefined>;
        }, undefined>, undefined>;
        readonly queue: v.ArraySchema<v.StrictObjectSchema<{
            readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly sourceId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly openedAtMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly quietDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly maximumDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
            readonly events: v.ArraySchema<v.StrictObjectSchema<{
                readonly messageHandle: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly providerTimeMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
                readonly receiptSequence: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
                readonly text: v.StringSchema<undefined>;
                readonly attachment: v.OptionalSchema<v.VariantSchema<"state", [v.StrictObjectSchema<{
                    readonly state: v.LiteralSchema<"pending", undefined>;
                    readonly sourceUrl: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                }, undefined>, v.StrictObjectSchema<{
                    readonly state: v.LiteralSchema<"ready", undefined>;
                    readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly mediaType: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly inputKind: v.PicklistSchema<["image", "file"], undefined>;
                    readonly localPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly hostPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                }, undefined>, v.StrictObjectSchema<{
                    readonly state: v.LiteralSchema<"omitted", undefined>;
                    readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly reason: v.PicklistSchema<["download_failed", "invalid_media", "copy_failed"], undefined>;
                }, undefined>], undefined>, undefined>;
            }, undefined>, undefined>;
        }, undefined>, undefined>;
        readonly active: v.OptionalSchema<v.VariantSchema<"kind", [v.StrictObjectSchema<{
            readonly kind: v.LiteralSchema<"codex", undefined>;
            readonly ownerBatchId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly joinedBatchIds: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            readonly batches: v.ArraySchema<v.StrictObjectSchema<{
                readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly sourceId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly openedAtMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
                readonly quietDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
                readonly maximumDeadlineMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
                readonly events: v.ArraySchema<v.StrictObjectSchema<{
                    readonly messageHandle: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly providerTimeMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
                    readonly receiptSequence: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
                    readonly text: v.StringSchema<undefined>;
                    readonly attachment: v.OptionalSchema<v.VariantSchema<"state", [v.StrictObjectSchema<{
                        readonly state: v.LiteralSchema<"pending", undefined>;
                        readonly sourceUrl: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                        readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    }, undefined>, v.StrictObjectSchema<{
                        readonly state: v.LiteralSchema<"ready", undefined>;
                        readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                        readonly mediaType: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                        readonly inputKind: v.PicklistSchema<["image", "file"], undefined>;
                        readonly localPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                        readonly hostPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    }, undefined>, v.StrictObjectSchema<{
                        readonly state: v.LiteralSchema<"omitted", undefined>;
                        readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                        readonly reason: v.PicklistSchema<["download_failed", "invalid_media", "copy_failed"], undefined>;
                    }, undefined>], undefined>, undefined>;
                }, undefined>, undefined>;
            }, undefined>, undefined>;
            readonly turnId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            readonly pendingAdmission: v.OptionalSchema<v.StrictObjectSchema<{
                readonly batchId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly clientUserMessageId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly publicationId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
                readonly expectedTurnId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            }, undefined>, undefined>;
            readonly binding: v.OptionalSchema<v.StrictObjectSchema<{
                readonly backend: v.PicklistSchema<["desktop", "proxy", "stdio"], undefined>;
                readonly host: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly codexHome: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly threadId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            }, undefined>, undefined>;
            readonly clientUserMessageId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            readonly publicationIds: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            readonly artifactBaseline: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            readonly admissionFailed: v.OptionalSchema<v.LiteralSchema<true, undefined>, undefined>;
        }, undefined>, v.StrictObjectSchema<{
            readonly kind: v.LiteralSchema<"delivery", undefined>;
            readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly sourceId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly batchIds: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            readonly parts: v.ArraySchema<v.StrictObjectSchema<{
                readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly payload: v.VariantSchema<"kind", [v.StrictObjectSchema<{
                    readonly kind: v.LiteralSchema<"text", undefined>;
                    readonly text: v.StringSchema<undefined>;
                }, undefined>, v.StrictObjectSchema<{
                    readonly kind: v.LiteralSchema<"media", undefined>;
                    readonly localPath: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly name: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly mediaType: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                    readonly mediaUrl: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                }, undefined>], undefined>;
                readonly status: v.PicklistSchema<["ready", "sending", "accepted", "failed", "skipped"], undefined>;
                readonly callbackToken: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
                readonly providerHandle: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            }, undefined>, undefined>;
        }, undefined>], undefined>, undefined>;
    }, undefined>, undefined>;
    readonly polling: v.OptionalSchema<v.RecordSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, v.StrictObjectSchema<{
        readonly activationAtMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly completedThroughMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly routeActivationAtMs: v.RecordSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>, undefined>;
    }, undefined>, undefined>, undefined>;
}, undefined>;
export type Receipt = v.InferOutput<typeof receiptSchema>;
export type RetainedResult = v.InferOutput<typeof resultSchema>;
export type GatewayState = v.InferOutput<typeof stateSchema>;
export type RouteState = v.InferOutput<typeof routeSchema>;
export type RouteBinding = v.InferOutput<typeof bindingSchema>;
export type Batch = v.InferOutput<typeof batchSchema>;
export type InboundEvent = v.InferOutput<typeof eventSchema>;
export type InboundAttachment = v.InferOutput<typeof attachmentSchema>;
export type CodexWork = v.InferOutput<typeof workSchema>;
export type AdmissionIntent = v.InferOutput<typeof intentSchema>;
export type Delivery = v.InferOutput<typeof deliverySchema>;
export type DeliveryPart = v.InferOutput<typeof partSchema>;
export declare const SEEN_RETENTION_MS: number;
export declare const ADMISSION_FAILURE = "Codex did not confirm the latest input. It was not sent again.";
export declare function routeBinding(route: GatewayRoute): RouteBinding;
export declare function validateState(value: unknown): GatewayState;
export declare function bindRoutes(state: GatewayState, config: GatewayConfig): void;
export declare class GatewayStore {
    readonly directory: string;
    private state;
    private readonly unlock;
    private readonly beforeWrite?;
    private queue;
    private poisoned;
    private closed;
    private closeFlight;
    private constructor();
    static open(directory: string, beforeWrite?: () => Promise<void>): Promise<GatewayStore>;
    snapshot(): GatewayState;
    /** Internal read-only projection: copy only the requested view, not the whole retained-result archive. */
    read<T>(select: (state: GatewayState) => T): T;
    transaction<T>(change: (draft: GatewayState) => T): Promise<T>;
    close(): Promise<void>;
}
export declare function unresolved(state: GatewayState): {
    unresolved: Array<{
        routeId: string;
        effectId: string;
        kind: "codex_admission" | "send";
    }>;
};
export declare function settlePart(part: DeliveryPart, delivery: Delivery, outcome: {
    status: "accepted";
    providerHandle: string;
} | {
    status: "failed";
}): void;
export declare function resolveEffect(state: GatewayState, routeId: string, effectId: string, resolution: "failed" | "accepted", providerHandle?: string): {
    providerHandle?: string | undefined;
    type: string;
    routeId: string;
    effectId: string;
    resolution: "failed" | "accepted";
};
/** Persist activation before network intake; existing checkpoints never reset at startup. */
export declare function initializePolling(state: GatewayState, config: GatewayConfig, now: number): void;
export {};
