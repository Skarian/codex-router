set(router_ca_files "")
if(CONFIG_ROUTER_PRIVATE_CA)
    if(NOT EXISTS "${CMAKE_CURRENT_SOURCE_DIR}/router_ca.pem")
        message(FATAL_ERROR "Private CA mode requires main/router_ca.pem. Copy the CA certificate, never its private key.")
    endif()
    list(APPEND router_ca_files "router_ca.pem")
endif()
idf_component_register(SRCS "main.c" "sse.c" "receiver.c" INCLUDE_DIRS "."
    REQUIRES esp_http_client esp-tls nvs_flash json protocol_examples_common esp_event esp_netif esp_hw_support
    EMBED_TXTFILES ${router_ca_files})
