#!/bin/sh
set -eu
base=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
out=$(mktemp -d "${TMPDIR:-/tmp}/router-esp32-parser.XXXXXX")
trap 'rm -rf "$out"' EXIT HUP INT TERM
if command -v pkg-config >/dev/null 2>&1 && pkg-config --exists libcjson; then
    cflags=$(pkg-config --cflags libcjson)
    libs=$(pkg-config --libs libcjson)
elif [ -f /opt/homebrew/include/cjson/cJSON.h ]; then
    cflags=-I/opt/homebrew/include/cjson
    libs='-L/opt/homebrew/lib -lcjson'
else
    echo 'A host cJSON development library is required; no installation was attempted.' >&2
    exit 1
fi
# Intentional word splitting for compiler/linker flag lists.
${CC:-cc} -std=c11 -Wall -Wextra -Werror -fsanitize=address,undefined $cflags -I"$base/main" \
    "$base/main/sse.c" "$base/main/receiver.c" "$base/test/parser_test.c" $libs -lm -o "$out/parser-test"
"$out/parser-test"
