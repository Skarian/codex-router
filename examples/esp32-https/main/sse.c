#include "sse.h"
#include <string.h>
void sse_init(sse_parser *p, sse_event_fn fn, void *context) {
    memset(p, 0, sizeof(*p)); p->callback = fn; p->context = context;
}
static bool line(sse_parser *p) {
    p->line[p->line_len] = 0;
    if (!p->line_len) {
        if (p->data_len) {
            p->data[--p->data_len] = 0;
            if (!p->callback(p->context, p->event, p->id, p->data)) return false;
        }
        p->data_len = 0; p->event[0] = 0; p->id[0] = 0; p->frame_bytes = 0;
    } else if (p->line[0] != ':') {
        char *value = strchr(p->line, ':');
        if (value) { *value++ = 0; if (*value == ' ') value++; } else value = p->line + p->line_len;
        size_t n = strlen(value);
        if (!strcmp(p->line, "data")) {
            if (p->data_len + n + 1 > SSE_FRAME_MAX) return false;
            memcpy(p->data + p->data_len, value, n); p->data_len += n; p->data[p->data_len++] = '\n';
        } else if (!strcmp(p->line, "event")) {
            if (n >= sizeof(p->event)) return false;
            memcpy(p->event, value, n + 1);
        } else if (!strcmp(p->line, "id")) {
            if (n > SSE_ID_MAX) return false;
            memcpy(p->id, value, n + 1);
        }
    }
    p->line_len = 0;
    return true;
}
bool sse_feed(sse_parser *p, const char *bytes, size_t length) {
    for (size_t i = 0; i < length; i++) {
        unsigned char ch = (unsigned char)bytes[i];
        if (p->after_cr && ch == '\n') { p->after_cr = false; continue; }
        p->after_cr = false;
        if (++p->frame_bytes > SSE_FRAME_MAX || ch == 0) return false;
        if (ch == '\r' || ch == '\n') { p->after_cr = ch == '\r'; if (!line(p)) return false; }
        else { if (p->line_len >= SSE_FRAME_MAX) return false; p->line[p->line_len++] = (char)ch; }
    }
    return true;
}
