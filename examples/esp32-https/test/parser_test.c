#include <assert.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include "sse.h"
#include "receiver.h"
static sse_parser parser;
static receiver r;
static char output[512];
static size_t length, commits, resets, total;
static bool sink(void *context, sink_op op, const char *kind, const char *text, size_t n) {
    (void)context; (void)kind;
    if (op == SINK_RESET || op == SINK_BEGIN) { length = 0; output[0] = 0; }
    if (op == SINK_RESET) resets++;
    if (op == SINK_TEXT) { total += n; if (length + n < sizeof(output)) { memcpy(output + length, text, n); length += n; output[length] = 0; } }
    if (op == SINK_COMMIT) commits++;
    return true;
}
static void setup(void) { receiver_init(&r, sink, NULL); sse_init(&parser, receiver_event, &r); length = commits = resets = total = 0; }
static void feed(const char *s) { for (size_t i = 0; i < strlen(s); i++) assert(sse_feed(&parser, s + i, 1)); }
static bool raw(void *context, const char *event, const char *id, const char *data) {
    (void)context; assert(!strcmp(event, "test")); assert(!strcmp(id, "abc")); assert(!strcmp(data, "one\ntwo")); commits++; return true;
}
int main(void) {
    setup(); sse_init(&parser, raw, NULL);
    feed(": heartbeat\r\nid: abc\r\nevent: test\r\ndata: one\r\ndata: two\r\n\r\n"); assert(commits == 1);
    setup();
    feed("id: a\nevent: commentary\ndata: {\"message_id\":\"m\",\"part\":0,\"end\":false,\"field\":\"text\",\"text\":\"hé😀\\n\"}\n\n");
    assert(!strcmp(output, "hé😀\n")); assert(!strcmp(r.cursor, "a"));
    // Transport loss drops only incomplete wire framing; message assembly and cursor survive.
    feed("id: unfinished\nevent: comm"); sse_init(&parser, receiver_event, &r);
    feed("id: b\nevent: commentary\ndata: {\"message_id\":\"m\",\"part\":1,\"end\":true,\"field\":\"text\",\"text\":\"world\"}\n\n");
    assert(!strcmp(output, "hé😀\nworld")); assert(commits == 1);
    feed("id: b\nevent: commentary\ndata: {\"message_id\":\"m\",\"part\":1,\"end\":true,\"field\":\"text\",\"text\":\"world\"}\n\n"); assert(commits == 1);
    feed("event: reset\ndata: {}\n\n"); assert(resets == 1 && length == 0 && !r.cursor[0]);
    feed("id: c\nevent: terminal\ndata: {\"message_id\":\"final\",\"part\":0,\"end\":false,\"field\":\"metadata\",\"text\":\"{\\\"status\\\":\\\"completed\\\"}\"}\n\n");
    assert(!r.terminal);
    feed("id: d\nevent: terminal\ndata: {\"message_id\":\"final\",\"part\":1,\"end\":true,\"field\":\"text\",\"text\":\"answer\"}\n\n"); assert(r.terminal && !strcmp(output, "answer"));
    // Many complete frames in one network read.
    setup(); const char *multi = ": heartbeat\n\nevent: status\ndata: {}\n\nevent: reset\ndata: {}\n\n";
    assert(sse_feed(&parser, multi, strlen(multi))); assert(resets == 1);
    setup(); char oversized[4098]; memset(oversized, 'x', sizeof(oversized)); assert(!sse_feed(&parser, oversized, sizeof(oversized)));
    setup(); const char *bad = "id: x\nevent: commentary\ndata: {\"message_id\":\"m\",\"part\":2,\"end\":true,\"field\":\"text\",\"text\":\"bad\"}\n\n";
    assert(!sse_feed(&parser, bad, strlen(bad))); assert(!r.cursor[0]);
    // The receiver processes a full 256KiB result with fixed parser/sink memory.
    setup(); char frame[4096], text[1025]; memset(text, 'z', 1024); text[1024] = 0;
    for (int i = 0; i < 256; i++) {
        int n = snprintf(frame, sizeof(frame), "id: %d\nevent: terminal\ndata: {\"message_id\":\"big\",\"part\":%d,\"end\":%s,\"field\":\"text\",\"text\":\"%s\"}\n\n", i, i, i == 255 ? "true" : "false", text);
        assert(n > 0 && (size_t)n < sizeof(frame)); assert(sse_feed(&parser, frame, (size_t)n));
    }
    assert(total == 256 * 1024 && r.terminal && commits == 1);
    puts("parser/receiver tests passed: byte splits, CRLF, multiline data, reconnect, reset, duplicate, terminal, bounds, 256KiB result");
    return 0;
}
