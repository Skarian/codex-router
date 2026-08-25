import assert from "node:assert/strict";
import test from "node:test";
import { parseRemoteControlSocketState } from "../src/app-server.js";
import { RouterError } from "../src/errors.js";

test("remote socket probe falls back only for an explicitly absent socket", () => {
  assert.equal(parseRemoteControlSocketState("socket\n"), true);
  assert.equal(parseRemoteControlSocketState("absent\n"), false);
  assert.throws(
    () => parseRemoteControlSocketState("other\n"),
    (error: unknown) => error instanceof RouterError && error.code === "app_server_connect_failed",
  );
  assert.throws(
    () => parseRemoteControlSocketState("ssh warning\n"),
    (error: unknown) => error instanceof RouterError && error.code === "app_server_protocol_failed",
  );
});
