#include "receiver.h"
#include "cJSON.h"
#include <math.h>
#include <string.h>
void receiver_init(receiver *r, sink_fn sink, void *context) {
    memset(r, 0, sizeof(*r)); r->sink = sink; r->context = context;
}
bool receiver_event(void *context, const char *event, const char *cursor, const char *data) {
    receiver *r = context;
    if (r->terminal) return true;
    if (!strcmp(event, "reset")) {
        if (!r->sink(r->context, SINK_RESET, "", "", 0)) return false;
        r->active = false; r->next_part = 0; r->cursor[0] = 0; return true;
    }
    if (!strcmp(event, "status")) return true;
    if (strcmp(event, "reasoning") && strcmp(event, "commentary") && strcmp(event, "terminal")) return false;
    if (!cursor[0] || strlen(cursor) > SSE_ID_MAX) return false;
    if (!strcmp(cursor, r->cursor)) return true;
    // cJSON exposes strings without lengths. Fail explicitly instead of truncating embedded NUL.
    if (strstr(data, "\\u0000")) return false;
    cJSON *root = cJSON_Parse(data);
    if (!root) return false;
    cJSON *id = cJSON_GetObjectItemCaseSensitive(root, "message_id");
    cJSON *part = cJSON_GetObjectItemCaseSensitive(root, "part");
    cJSON *end = cJSON_GetObjectItemCaseSensitive(root, "end");
    cJSON *field = cJSON_GetObjectItemCaseSensitive(root, "field");
    cJSON *text = cJSON_GetObjectItemCaseSensitive(root, "text");
    bool ok = cJSON_IsString(id) && strlen(id->valuestring) <= 512 && cJSON_IsNumber(part)
        && part->valuedouble >= 0 && part->valuedouble <= 1000000 && floor(part->valuedouble) == part->valuedouble
        && cJSON_IsBool(end) && cJSON_IsString(field) && cJSON_IsString(text);
    if (ok && !r->active) {
        ok = part->valuedouble == 0 && r->sink(r->context, SINK_BEGIN, event, id->valuestring, strlen(id->valuestring));
        if (ok) { strcpy(r->message_id, id->valuestring); strcpy(r->kind, event); r->next_part = 0; r->active = true; }
    }
    if (ok) ok = !strcmp(r->message_id, id->valuestring) && !strcmp(r->kind, event) && part->valuedouble == (double)r->next_part;
    if (ok) {
        sink_op op = !strcmp(field->valuestring, "text") ? SINK_TEXT : SINK_METADATA;
        ok = (!strcmp(field->valuestring, "text") || !strcmp(field->valuestring, "metadata"))
            && r->sink(r->context, op, event, text->valuestring, strlen(text->valuestring));
    }
    if (ok && cJSON_IsTrue(end)) {
        ok = r->sink(r->context, SINK_COMMIT, event, "", 0);
        if (ok) { r->active = false; r->terminal = !strcmp(event, "terminal"); }
    }
    if (ok) { r->next_part++; strcpy(r->cursor, cursor); }
    cJSON_Delete(root); return ok;
}
