import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig, conversationId } from "../src/config.js";
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

test("parseConfig accepts an SSH host for a remote agent", () => {
  const config = parseConfig(VALID.replace('reasoning = "medium"', 'reasoning = "medium"\nssh_host = "doordash.exe.xyz"'));
  assert.equal(config.agents[0]?.sshHost, "doordash.exe.xyz");
});

test("parseConfig rejects SSH hosts that could be parsed as options", () => {
  assert.throws(
    () => parseConfig(VALID.replace('reasoning = "medium"', 'reasoning = "medium"\nssh_host = "-oProxyCommand=bad"')),
    (error: unknown) => error instanceof RouterError && error.code === "config_invalid",
  );
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

const POLLING = `
[[gateway.sendblue]]
id = "personal"
api_key_id_env = "SB_KEY"
api_secret_key_env = "SB_SECRET"
[[gateway.sendblue.conversations]]
sender = "+15125550100"
sendblue_number = "+15125550200"
agent = "alpha"
`;
const invalid = (error: unknown) => error instanceof RouterError && error.code === "config_invalid";

test("HTTP discovers the agent catalog without credentials or a second route", () => {
  const config = parseConfig(VALID + "[gateway.http]\n");
  assert.deepEqual(config.gateway!.http, { port: 8787, api: true });
  assert.equal(config.gateway!.agents[0], config.agents[0]);
  assert.deepEqual(config.gateway!.sendblue, []);
  assert.equal(config.gateway!.maxRequests, 1024);
});

test("HTTP listener validates nested settings and rejects removed network/auth schema", () => {
  assert.deepEqual(parseConfig(VALID + "[gateway.http]\nport=8788\napi=false").gateway!.http, { port: 8788, api: false });
  for (const value of ['port=0', 'port=65536', 'port=1.5', 'port="8787"', 'api="false"', 'host="0.0.0.0"', 'tls={}']) {
    assert.throws(() => parseConfig(VALID + "[gateway.http]\n" + value), invalid);
  }
  for (const value of ['listen_port=8787', 'listen_host="127.0.0.1"', 'tls={cert="/tmp/a",key="/tmp/b"}', 'https=[]', 'routes=[]', 'public_url="https://example.com"']) {
    assert.throws(() => parseConfig(VALID + "[gateway]\n" + value), invalid);
  }
});

test("polling needs no HTTP listener, public URL or webhook secret", () => {
  const account = parseConfig(VALID + POLLING).gateway!;
  assert.equal(account.http, undefined);
  assert.equal(account.sendblue[0]!.mode, "poll");
  assert.equal(account.sendblue[0]!.conversations[0]!.id, conversationId("personal", "+15125550200", "+15125550100"));
  assert.equal(account.sendblue[0]!.conversations[0]!.agent.id, "alpha");
});

test("multiple conversations can select one agent but ambiguous mappings cannot", () => {
  const extra = `[[gateway.sendblue.conversations]]
sender = "+15125550300"
sendblue_number = "+15125550200"
agent = "alpha"`;
  const config = parseConfig(VALID + POLLING + extra).gateway!;
  assert.equal(config.sendblue[0]!.conversations.length, 2);
  assert.throws(() => parseConfig(VALID + POLLING + extra.replace("+15125550300", "+15125550100")), invalid);
  assert.throws(() => parseConfig(VALID + POLLING.replace('agent = "alpha"', 'agent = "missing"')), invalid);
  assert.throws(() => parseConfig(VALID + POLLING.replace('+15125550100', '5125550100')), invalid);
});

test("webhooks require their own HTTPS public origin and listener but can disable the API", () => {
  const webhook = POLLING.replace('id = "personal"', 'id = "personal"\nmode="webhook"\npublic_url="https://gateway.example.com"\nwebhook_secret_env="HOOK"');
  assert.throws(() => parseConfig(VALID + webhook), invalid);
  const config = parseConfig(VALID + '[gateway.http]\napi=false\n' + webhook).gateway!;
  assert.equal(config.http!.api, false);
  assert.equal(config.sendblue[0]!.publicUrl, "https://gateway.example.com");
  for (const url of ["http://example.com", "https://user@example.com", "https://example.com/path", "https://example.com/?secret=1"]) {
    assert.throws(() => parseConfig(VALID + '[gateway.http]\n' + webhook.replace('https://gateway.example.com', url)), invalid);
  }
  assert.throws(() => parseConfig(VALID + '[gateway.http]\n' + webhook.replace('webhook_secret_env="HOOK"', '')), invalid);
});

test("credentials require one source without echoing secrets", () => {
  for (const replacement of ['', 'api_key_id="SECRET"\napi_key_id_env="KEY"', 'api_key_id="SECRET\\nVALUE"', 'api_key_id_env="BAD-NAME"']) {
    assert.throws(() => parseConfig(VALID + POLLING.replace('api_key_id_env = "SB_KEY"', replacement)),
      error => invalid(error) && !(error as Error).message.includes("SECRET"));
  }
});

test("retention bounds require positive safe integers", () => {
  const config = parseConfig(VALID + '[gateway]\nmax_requests=25\nretained_bytes=1048576\n[gateway.http]').gateway!;
  assert.equal(config.maxRequests, 25);
  assert.equal(config.retainedBytes, 1048576);
  for (const key of ['max_requests', 'retained_bytes']) for (const value of ['0', '-1', '1.5', '"10"', '9007199254740992']) {
    assert.throws(() => parseConfig(VALID + `[gateway]\n${key}=${value}`), invalid);
  }
});

test("polling timestamps normalize and invalid modes or dates fail", () => {
  assert.equal(parseConfig(VALID + POLLING.replace('id = "personal"', 'id = "personal"\npoll_start="2026-09-27T02:00:00-05:00"')).gateway!.sendblue[0]!.pollStart, "2026-09-27T07:00:00.000Z");
  for (const value of ['mode="invalid"', 'poll_start="yesterday"', 'poll_start="2026-02-30T00:00:00Z"', 'poll_start="2026-09-27"']) {
    assert.throws(() => parseConfig(VALID + POLLING.replace('id = "personal"', `id = "personal"\n${value}`)), invalid);
  }
});

test("execution target identity includes configured host and rejects local aliases", () => {
  const remote = VALID.replace('id = "alpha"', 'id = "remote"').replace('label = "Alpha"', 'label = "Remote"') + 'ssh_host="server"\n';
  assert.equal(parseConfig(VALID + remote).agents.length, 2);
  assert.throws(() => parseConfig(VALID + remote.replace('ssh_host="server"', '')), invalid);
});
