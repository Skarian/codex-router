#pragma once
#include <stdbool.h>
#include <stddef.h>
#define SSE_FRAME_MAX 4096
#define SSE_ID_MAX 1024
typedef bool (*sse_event_fn)(void *, const char *, const char *, const char *);
typedef struct {
    char line[SSE_FRAME_MAX + 1], data[SSE_FRAME_MAX + 1], id[SSE_ID_MAX + 1], event[32];
    size_t line_len, data_len, frame_bytes;
    bool after_cr;
    sse_event_fn callback;
    void *context;
} sse_parser;
void sse_init(sse_parser *, sse_event_fn, void *);
bool sse_feed(sse_parser *, const char *, size_t);
