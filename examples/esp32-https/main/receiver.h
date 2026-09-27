#pragma once
#include "sse.h"
typedef enum { SINK_RESET, SINK_BEGIN, SINK_TEXT, SINK_METADATA, SINK_COMMIT } sink_op;
typedef bool (*sink_fn)(void *, sink_op, const char *, const char *, size_t);
typedef struct {
    char cursor[SSE_ID_MAX + 1], message_id[513], kind[16];
    size_t next_part;
    bool active, terminal;
    sink_fn sink;
    void *context;
} receiver;
void receiver_init(receiver *, sink_fn, void *);
bool receiver_event(void *, const char *, const char *, const char *);
