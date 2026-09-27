#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <stdint.h>
#include "sdkconfig.h"
#include "cJSON.h"
#ifndef CONFIG_ROUTER_PRIVATE_CA
#include "esp_crt_bundle.h"
#endif
#include "esp_event.h"
#include "esp_http_client.h"
#include "esp_log.h"
#include "esp_netif.h"
#include "esp_netif_sntp.h"
#include "esp_random.h"
#include "nvs_flash.h"
#include "protocol_examples_common.h"
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "receiver.h"

#ifdef CONFIG_ROUTER_PRIVATE_CA
extern const char router_ca_pem_start[] asm("_binary_router_ca_pem_start");
#endif

#define PROMPT_MAX 1024
static const char *TAG = "router";
typedef struct { unsigned version; bool done; int64_t created; char id[37], prompt[PROMPT_MAX + 1], origin[256], route[64]; } pending_record;
static pending_record pending;
static receiver messages;
static sse_parser parser;
static nvs_handle_t storage;
// Replaceable display state. This example shows a labeled tail preview, not a transcript.
static struct { char tail[257]; size_t length, total; } preview;
static bool sink(void *context, sink_op op, const char *kind, const char *bytes, size_t n) {
    (void)context;
    if (op == SINK_RESET || op == SINK_BEGIN) memset(&preview, 0, sizeof(preview));
    if (op == SINK_TEXT) {
        preview.total += n;
        if (n >= 256) { memcpy(preview.tail, bytes + n - 256, 256); preview.length = 256; }
        else { size_t drop = preview.length + n > 256 ? preview.length + n - 256 : 0;
            memmove(preview.tail, preview.tail + drop, preview.length - drop); preview.length -= drop;
            memcpy(preview.tail + preview.length, bytes, n); preview.length += n; }
        preview.tail[preview.length] = 0;
    }
    if (op == SINK_COMMIT) {
        size_t start = 0; while (start < preview.length && ((unsigned char)preview.tail[start] & 0xc0) == 0x80) start++;
        ESP_LOGI(TAG, "%s complete (%u text bytes); tail preview: %s", kind, (unsigned)preview.total, preview.tail + start);
    }
    return true;
}
static void save(void) {
    ESP_ERROR_CHECK(nvs_set_blob(storage, "request", &pending, sizeof(pending)));
    ESP_ERROR_CHECK(nvs_commit(storage));
}
static void load(void) {
    size_t size = sizeof(pending);
    esp_err_t result = nvs_get_blob(storage, "request", &pending, &size);
    if (result == ESP_ERR_NVS_NOT_FOUND) {
        unsigned char id[16]; esp_fill_random(id, sizeof(id)); id[6] = (id[6] & 15) | 64; id[8] = (id[8] & 63) | 128;
        snprintf(pending.id, sizeof(pending.id), "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
            id[0],id[1],id[2],id[3],id[4],id[5],id[6],id[7],id[8],id[9],id[10],id[11],id[12],id[13],id[14],id[15]);
        if (strlen(CONFIG_ROUTER_PROMPT) > PROMPT_MAX || strlen(CONFIG_ROUTER_ORIGIN) >= sizeof(pending.origin) || strlen(CONFIG_ROUTER_ROUTE) >= sizeof(pending.route)) abort();
        strcpy(pending.prompt, CONFIG_ROUTER_PROMPT); strcpy(pending.origin, CONFIG_ROUTER_ORIGIN); strcpy(pending.route, CONFIG_ROUTER_ROUTE);
        pending.version = 1; pending.created = (int64_t)time(NULL); save(); // UUID and exact text/target are durable before any POST.
    } else {
        ESP_ERROR_CHECK(result);
        if (size != sizeof(pending) || pending.version != 1 || pending.id[36] || pending.prompt[PROMPT_MAX] || pending.origin[255] || pending.route[63]) abort();
        if (strcmp(pending.origin, CONFIG_ROUTER_ORIGIN) || strcmp(pending.route, CONFIG_ROUTER_ROUTE)) {
            ESP_LOGE(TAG, "Saved request belongs to another target; refusing to rebind it"); abort();
        }
    }
}
static esp_http_client_handle_t client(const char *url) {
    esp_http_client_config_t config = { .url = url,
#ifdef CONFIG_ROUTER_PRIVATE_CA
        .cert_pem = router_ca_pem_start,
#else
        .crt_bundle_attach = esp_crt_bundle_attach,
#endif
        .skip_cert_common_name_check = false,
        .timeout_ms = 25000, .disable_auto_redirect = true, .buffer_size = 1024 };
    esp_http_client_handle_t http = esp_http_client_init(&config);
    if (!http) abort();
    char authorization[512];
    if (snprintf(authorization, sizeof(authorization), "Bearer %s", CONFIG_ROUTER_TOKEN) >= (int)sizeof(authorization)) abort();
    ESP_ERROR_CHECK(esp_http_client_set_header(http, "Authorization", authorization)); return http;
}
static int submit(const char *url) {
    cJSON *body = cJSON_CreateObject(); cJSON_AddStringToObject(body, "request_id", pending.id); cJSON_AddStringToObject(body, "text", pending.prompt);
    char *encoded = cJSON_PrintUnformatted(body); if (!encoded) abort();
    esp_http_client_handle_t http = client(url);
    esp_http_client_set_method(http, HTTP_METHOD_POST);
    esp_http_client_set_header(http, "Content-Type", "application/json");
    esp_http_client_set_post_field(http, encoded, (int)strlen(encoded));
    esp_err_t result = esp_http_client_perform(http);
    int status = result == ESP_OK ? esp_http_client_get_status_code(http) : 0;
    esp_http_client_cleanup(http); cJSON_free(encoded); cJSON_Delete(body); return status;
}
static int events(const char *url) {
    esp_http_client_handle_t http = client(url);
    esp_http_client_set_header(http, "Accept", "text/event-stream");
    if (messages.cursor[0]) esp_http_client_set_header(http, "Last-Event-ID", messages.cursor);
    sse_init(&parser, receiver_event, &messages); // Preserve logical assembly/cursor across transport loss.
    int status = 0;
    if (esp_http_client_open(http, 0) != ESP_OK || esp_http_client_fetch_headers(http) < 0) goto done;
    status = esp_http_client_get_status_code(http);
    if (status != 200) goto done;
    char buffer[512];
    while (!messages.terminal) {
        int n = esp_http_client_read(http, buffer, sizeof(buffer));
        if (n <= 0) break;
        if (!sse_feed(&parser, buffer, (size_t)n)) {
            ESP_LOGE(TAG, "Invalid or unsupported SSE frame; stop without acknowledging it"); status = -1; break;
        }
    }
done:
    esp_http_client_close(http); esp_http_client_cleanup(http); return status;
}
void app_main(void) {
    // Never erase NVS automatically: it holds the no-replay request identity.
    ESP_ERROR_CHECK(nvs_flash_init()); ESP_ERROR_CHECK(nvs_open("router", NVS_READWRITE, &storage));
    ESP_ERROR_CHECK(esp_netif_init()); ESP_ERROR_CHECK(esp_event_loop_create_default()); ESP_ERROR_CHECK(example_connect());
    esp_sntp_config_t clock_config = ESP_NETIF_SNTP_DEFAULT_CONFIG("pool.ntp.org");
    ESP_ERROR_CHECK(esp_netif_sntp_init(&clock_config));
    ESP_ERROR_CHECK(esp_netif_sntp_sync_wait(pdMS_TO_TICKS(15000)));
    load();
    if (pending.done) { ESP_LOGI(TAG, "Saved request already completed; no resubmission"); return; }
    if (strncmp(pending.origin, "https://", 8)) abort();
    char submit_url[512], events_url[576];
    snprintf(submit_url, sizeof(submit_url), "%s/v1/routes/%s/requests", pending.origin, pending.route);
    snprintf(events_url, sizeof(events_url), "%s/%s/events", submit_url, pending.id);
    receiver_init(&messages, sink, NULL);
    // Recovery first: an existing durable request may have completed while the device was off.
    bool need_submit = false;
    for (;;) {
        int status;
        bool submitting = need_submit;
        if (need_submit) {
            int64_t age = (int64_t)time(NULL) - pending.created;
            if (age < 0 || age >= 29LL * 86400) { ESP_LOGE(TAG, "Retry window expired; saved identity retained"); break; }
            status = submit(submit_url);
            if (status == 202) need_submit = false;
        } else {
            status = events(events_url);
            if (messages.terminal) { pending.done = true; save(); ESP_LOGI(TAG, "Terminal result consumed"); break; }
            if (status == 404) {
                int64_t age = (int64_t)time(NULL) - pending.created;
                if (age < 0 || age >= 29LL * 86400) { ESP_LOGE(TAG, "Request absent outside safe retry window; saved identity retained"); break; }
                need_submit = true;
            }
        }
        if (status == -1 || (status >= 400 && status < 500 && status != 429 && !(status == 404 && !submitting)) || (status >= 300 && status < 400)) {
            ESP_LOGE(TAG, "Stopped on HTTP/protocol status %d; saved request retained", status); break;
        }
        vTaskDelay(pdMS_TO_TICKS(3000));
    }
}
