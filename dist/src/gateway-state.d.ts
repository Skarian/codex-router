import * as v from "valibot";
import type { GatewayConfig, GatewayRoute } from "./config.js";
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
    readonly publicationId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly expectedTurnId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
}, undefined>;
declare const workSchema: v.StrictObjectSchema<{
    readonly kind: v.LiteralSchema<"codex", undefined>;
    readonly ownerBatchId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly joinedBatchIds: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
    readonly batches: v.ArraySchema<v.StrictObjectSchema<{
        readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
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
        readonly publicationId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly expectedTurnId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
    }, undefined>, undefined>;
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
declare const bindingSchema: v.StrictObjectSchema<{
    readonly sendblueId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly sender: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly sendblueNumber: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    readonly target: v.StrictObjectSchema<{
        readonly sshHost: v.NullableSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        readonly threadId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly cwd: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
    }, undefined>;
}, undefined>;
declare const routeSchema: v.StrictObjectSchema<{
    readonly binding: v.StrictObjectSchema<{
        readonly sendblueId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly sender: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly sendblueNumber: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly target: v.StrictObjectSchema<{
            readonly sshHost: v.NullableSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            readonly threadId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly cwd: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        }, undefined>;
    }, undefined>;
    readonly nextSequence: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
    readonly seenMessages: v.ArraySchema<v.StrictObjectSchema<{
        readonly sendblueId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly messageHandle: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
        readonly receivedAtMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
    }, undefined>, undefined>;
    readonly openBatch: v.OptionalSchema<v.StrictObjectSchema<{
        readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
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
            readonly publicationId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly expectedTurnId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        }, undefined>, undefined>;
        readonly publicationIds: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        readonly artifactBaseline: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
        readonly admissionFailed: v.OptionalSchema<v.LiteralSchema<true, undefined>, undefined>;
    }, undefined>, v.StrictObjectSchema<{
        readonly kind: v.LiteralSchema<"delivery", undefined>;
        readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
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
    readonly version: v.LiteralSchema<1, undefined>;
    readonly routes: v.RecordSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, v.StrictObjectSchema<{
        readonly binding: v.StrictObjectSchema<{
            readonly sendblueId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly sender: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly sendblueNumber: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly target: v.StrictObjectSchema<{
                readonly sshHost: v.NullableSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
                readonly threadId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly cwd: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            }, undefined>;
        }, undefined>;
        readonly nextSequence: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        readonly seenMessages: v.ArraySchema<v.StrictObjectSchema<{
            readonly sendblueId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly messageHandle: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
            readonly receivedAtMs: v.SchemaWithPipe<readonly [v.NumberSchema<undefined>, v.SafeIntegerAction<number, undefined>, v.MinValueAction<number, 0, undefined>]>;
        }, undefined>, undefined>;
        readonly openBatch: v.OptionalSchema<v.StrictObjectSchema<{
            readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
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
                readonly publicationId: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
                readonly expectedTurnId: v.OptionalSchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            }, undefined>, undefined>;
            readonly publicationIds: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            readonly artifactBaseline: v.ArraySchema<v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>, undefined>;
            readonly admissionFailed: v.OptionalSchema<v.LiteralSchema<true, undefined>, undefined>;
        }, undefined>, v.StrictObjectSchema<{
            readonly kind: v.LiteralSchema<"delivery", undefined>;
            readonly id: v.SchemaWithPipe<readonly [v.StringSchema<undefined>, v.MinLengthAction<string, 1, undefined>]>;
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
}, undefined>;
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
export {};
