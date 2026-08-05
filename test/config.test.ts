import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig } from "../src/config.js";
import { RouterError } from "../src/errors.js";

const VALID = `
[[agents]]
id = "alpha"
label = "Alpha"
cwd = "/tmp/alpha"
thread_id = "019-secret-thread"
model = "gpt-test"
reasoning = "medium"
`;

test("parseConfig preserves configured agent order and fields", () => {
  const config = parseConfig(`${VALID}\n[[agents]]\nid = "home"\nlabel = "Home"\ncwd = "/tmp/home"\nthread_id = "019-home"\nmodel = "gpt-test"\nreasoning = "high"\n`);
  assert.deepEqual(config.agents.map(({ id, label }) => ({ id, label })), [
    { id: "alpha", label: "Alpha" },
    { id: "home", label: "Home" },
  ]);
  assert.equal(config.agents[0]?.threadId, "019-secret-thread");
});

test("parseConfig accepts an empty configuration", () => {
  assert.deepEqual(parseConfig(""), { agents: [] });
});

test("parseConfig allows Codex to choose the model's default reasoning effort", () => {
  const config = parseConfig(VALID.replace('reasoning = "medium"', ""));
  assert.equal(config.agents[0]?.reasoning, undefined);
});

test("parseConfig rejects a present but empty reasoning effort", () => {
  assert.throws(
    () => parseConfig(VALID.replace('reasoning = "medium"', 'reasoning = ""')),
    (error: unknown) => error instanceof RouterError && error.code === "config_invalid",
  );
});

test("parseConfig rejects duplicate ids", () => {
  assert.throws(
    () => parseConfig(`${VALID}\n${VALID}`),
    (error: unknown) => error instanceof RouterError && error.code === "config_invalid" && !error.message.includes("019-secret-thread"),
  );
});

test("parseConfig rejects ids outside the lowercase slug contract", () => {
  assert.throws(
    () => parseConfig(VALID.replace('id = "alpha"', 'id = "Alpha_bad"')),
    (error: unknown) => error instanceof RouterError && error.code === "config_invalid",
  );
});
