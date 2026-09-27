# ESP32 HTTPS request client

This ESP-IDF example sends one durable request to a configured Codex Router route. It reads completed commentary and the final result through the request's SSE endpoint. It does not subscribe to other clients' messages or synchronize a chat transcript.

## Build and configure

Use an existing ESP-IDF environment with `esp_http_client`, cJSON, NVS, and the certificate bundle. The project uses ESP-IDF's `protocol_examples_common` connection helper.

```sh
idf.py set-target esp32
idf.py menuconfig
idf.py build
idf.py flash monitor
```

In `menuconfig`, configure the example connection settings and the **Codex Router example** settings:

- HTTPS origin, without a trailing slash
- Private CA option, when the gateway uses a private issuer
- Existing route ID
- HTTPS account bearer token
- Prompt, up to 1024 UTF-8 bytes in this sample

The gateway API supports larger prompts. This sample intentionally limits its NVS record and POST allocation. Development settings contain the token in the firmware and build configuration. Use device provisioning and protected storage for a deployed client; do not commit a real token.

TLS verifies the server hostname and certificate issuer. The default configuration uses the ESP certificate bundle. Private CA mode uses the PEM certificate described below. Redirects are disabled so the bearer token stays with the configured gateway. SNTP synchronizes time before HTTPS and establishes the conservative retry window.

### Trust a private LAN certificate

1. Obtain the CA certificate from the gateway administrator through a trusted channel.
2. Copy that certificate into `main/router_ca.pem`:

   ```sh
   cp /path/to/ca.crt main/router_ca.pem
   ```

3. In `menuconfig`, enable **Codex Router example → Trust a private CA from main/router_ca.pem**.
4. Set the HTTPS origin to the gateway address, such as `https://192.168.1.50:8787`.
5. Verify that the server certificate covers this IP address or hostname in its Subject Alternative Name.
6. Build and flash the firmware.

CMake embeds the PEM as text when `CONFIG_ROUTER_PRIVATE_CA` is enabled. It stops with an error when the file is absent. This file is excluded from Git. Copy only the CA certificate; never copy the CA or server private key.

The client sets `cert_pem` in private CA mode and leaves hostname verification enabled. It does not fall back to an untrusted certificate. Without private CA mode, it uses `crt_bundle_attach`. These are the [ESP-IDF certificate verification options](https://docs.espressif.com/projects/esp-idf/en/v5.3/esp32/api-reference/protocols/esp_http_client.html#https-request).

A new CA requires new firmware with its certificate. A server certificate renewal under the same CA does not require a client change. See the [gateway HTTPS configuration](../../docs/https.md#configuration) for native TLS and private address configuration.

## Request and reboot behavior

Before the first POST, one NVS blob stores the UUID, exact prompt, original origin/route, and creation time. The client reuses that record after reboot. It refuses to send the record to a changed target. Changing the configured prompt does not modify a pending request.

The client first opens the saved request's `/events` endpoint. If the gateway already knows the request, streaming resumes or the stored terminal result is replayed. A `404` permits a POST with the saved UUID and exact text only while the record is less than 29 days old. This is deliberately shorter than the gateway's 30-day terminal retention guarantee. POST transport failures retry that same identity. Auth, conflict, malformed-input, redirect, and unsupported-frame errors stop without deleting the saved record. Capacity and temporary transport failures retry after three seconds.

A terminal event may describe success, failure, or interruption. Only its final part completes reception. The client then marks the NVS record done and stops reconnecting. A completed saved record is not resubmitted after reboot. The example is one-shot: an application UI should create the next record only after acknowledging the previous terminal result. Do not erase a pending record to recover from a lost response.

Only request creation and completion write NVS. SSE cursors stay in RAM. The retry window assumes a correct synchronized clock; this sample does not defend against a malicious time service or an operator deleting gateway receipts before their advertised expiry.

## Bounded parser and display adapter

The HTTP reader uses a 512-byte buffer. The SSE parser accepts split lines, byte-level UTF-8 splits, CRLF, multiple data lines, comments, and multiple frames per network read. Buffers are fixed at the gateway's 4096-byte frame bound plus bounded event/ID storage. cJSON parses one complete frame at a time. A 256 KiB response never requires a 256 KiB allocation.

Frames have `message_id`, `part`, `end`, `field`, and `text`. The `field` is either `text` or `metadata`. Metadata parts contain serialized JSON, which can itself span several frames. The receiver checks message identity and sequential part numbers. It advances its RAM cursor only after the sink accepts a frame. Partial network frames are discarded on reconnect, while the active logical message and cursor remain available for resumed delivery.

The replaceable sink receives these operations:

- `SINK_RESET`: invalidate partial presentation/storage and clear assembly state
- `SINK_BEGIN`: begin a replacement message
- `SINK_TEXT` / `SINK_METADATA`: consume one bounded piece
- `SINK_COMMIT`: publish the completed logical message

The provided sink keeps a **256-byte text tail preview** and a total byte count. It consumes every text piece, clears partial state on reset, and logs only after commit. Its output is explicitly a preview, not the full transcript. Metadata is passed to the sink but the default preview does not render it. Replace this sink with a real display adapter or incremental temporary-file writer plus commit/abort operations. Serial diagnostic logs are not a reversible display or a durable transcript.

cJSON exposes decoded strings without lengths. This sample explicitly stops on `\u0000` rather than silently truncating an embedded NUL. The conservative check can also reject a literal escaped representation of that sequence. Applications that require arbitrary text containing NUL need a length-aware JSON-string decoder. Other UTF-8 text, escaped newlines, quotes, and backslashes use ordinary cJSON decoding.

No exactly-once display claim is made across device reboots. The same durable terminal result may be displayed again after a crash between display commit and the NVS completion write; its Codex input is not resubmitted.

## Host tests

A host C compiler and cJSON development library are required. The script discovers `libcjson` through pkg-config or a standard Apple Silicon Homebrew installation. It installs nothing and places all test artifacts in a temporary directory.

```sh
./test/run-host.sh
```

The tests compile the real parser and receiver with warnings as errors, AddressSanitizer, and UndefinedBehaviorSanitizer. They cover byte-level fragmentation, CRLF, multiline data, UTF-8, transport reconnection, replayed frame IDs, reset, terminal completion, malformed part order, size bounds, and processing a full 256 KiB result with fixed receiver memory.

Current validation: host parser/receiver tests pass. The ESP-IDF toolchain was unavailable during implementation, so the ESP-IDF application has **not** been compiled or run on physical hardware. NVS, Wi-Fi, SNTP, private CA embedding, and TLS still require that qualification. Host parser tests do not certify those paths.
