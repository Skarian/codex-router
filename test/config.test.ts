import assert from "node:assert/strict";
import test from "node:test";
import { parseConfig, routeSources } from "../src/config.js";
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

const HTTPS_GATEWAY = `
[gateway]
listen_port = 8787
[[gateway.https]]
id = "tools"
bearer_token_env = "ROUTER_TOKEN"
[[gateway.routes]]
id = "assistant"
agent = "alpha"
https = "tools"
`;
const SENDBLUE_GATEWAY = `
[gateway]
listen_port = 8787
public_url = "https://gateway.example.com"
[[gateway.sendblue]]
id = "personal"
mode = "webhook"
api_key_id_env = "SB_KEY"
api_secret_key_env = "SB_SECRET"
webhook_secret_env = "SB_WEBHOOK"
[[gateway.routes]]
id = "assistant"
agent = "alpha"
sendblue = "personal"
sender = "+15125550100"
sendblue_number = "+15125550200"
`;

test("HTTPS-only configuration needs neither Sendblue credentials nor a callback origin", () => {
  const gateway = parseConfig(VALID + HTTPS_GATEWAY).gateway!;
  assert.equal(gateway.publicUrl, undefined);
  assert.deepEqual(gateway.sendblue, []);
  assert.deepEqual(gateway.https, [{ id: "tools", bearerTokenEnv: "ROUTER_TOKEN" }]);
  assert.equal(gateway.maxRequests, 1024); assert.equal(gateway.retainedBytes, 8 * 1024 * 1024);
  assert.deepEqual(routeSources(gateway.routes[0]!), [{ kind: "https", id: "https:tools", accountId: "tools" }]);
});

test("legacy Sendblue routes retain fields and normalize their source identity", () => {
  const gateway = parseConfig(VALID + SENDBLUE_GATEWAY).gateway!;
  const route = gateway.routes[0]!;
  assert.equal(route.sendblueId, "personal"); assert.equal(route.sender, "+15125550100");
  assert.equal(route.sendblueNumber, "+15125550200");
  assert.deepEqual(routeSources(route), [{ kind: "sendblue", id: "sendblue:personal", accountId: "personal", sender: route.sender, sendblueNumber: route.sendblueNumber }]);
});

test("one logical route can bind Sendblue and HTTPS without a second execution target", () => {
  const source = SENDBLUE_GATEWAY.replace("[[gateway.routes]]", '[[gateway.https]]\nid="tools"\nbearer_token="test-token"\n[[gateway.routes]]') + 'https = "tools"\n';
  const gateway = parseConfig(VALID + source).gateway!;
  assert.equal(gateway.routes.length, 1);
  assert.deepEqual(routeSources(gateway.routes[0]!).map(value => value.kind), ["sendblue", "https"]);
  assert.equal(gateway.https![0]!.bearerToken, "test-token");
});

test("HTTPS credentials require exactly one valid token source without leaking values", () => {
  for (const credentials of [
    '', 'bearer_token="private-token"\nbearer_token_env="ROUTER_TOKEN"',
    'bearer_token=""', 'bearer_token="private token"', 'bearer_token="private\\nsecret"',
    'bearer_token_env="BAD-NAME"', 'bearer_token_env=""', 'bearer_token="private-token"\nunknown=true',
  ]) {
    assert.throws(() => parseConfig(VALID + HTTPS_GATEWAY.replace('bearer_token_env = "ROUTER_TOKEN"', credentials)),
      (error: unknown) => error instanceof RouterError && error.code === "config_invalid" && !error.message.includes("private"));
  }
});

test("unknown accounts, missing bindings, stray phone fields, and duplicate accounts are rejected", () => {
  for (const gateway of [
    HTTPS_GATEWAY.replace('https = "tools"', 'https = "missing"'),
    HTTPS_GATEWAY.replace('https = "tools"', ''),
    HTTPS_GATEWAY + 'sender="+15125550100"\n',
    HTTPS_GATEWAY.replace('[[gateway.routes]]', '[[gateway.https]]\nid="tools"\nbearer_token="token"\n[[gateway.routes]]'),
    SENDBLUE_GATEWAY.replace('public_url = "https://gateway.example.com"', ''),
  ]) assert.throws(() => parseConfig(VALID + gateway), (error: unknown) => error instanceof RouterError && error.code === "config_invalid");
});

test("retained request limits accept positive safe integers and reject invalid values", () => {
  const configured = parseConfig(VALID + HTTPS_GATEWAY.replace('listen_port = 8787', 'listen_port = 8787\nmax_requests=25\nretained_bytes=1048576')).gateway!;
  assert.equal(configured.maxRequests, 25); assert.equal(configured.retainedBytes, 1048576);
  for (const key of ["max_requests", "retained_bytes"]) for (const value of ["0", "-1", "1.5", '"10"', "9007199254740992"]) {
    assert.throws(() => parseConfig(VALID + HTTPS_GATEWAY.replace('listen_port = 8787', `listen_port = 8787\n${key}=${value}`)),
      (error: unknown) => error instanceof RouterError && error.code === "config_invalid");
  }
});

test("one execution target cannot be split across connector routes", () => {
  const source = HTTPS_GATEWAY + '[[gateway.routes]]\nid="second"\nagent="alpha"\nhttps="tools"\n';
  assert.throws(() => parseConfig(VALID + source), (error: unknown) => error instanceof RouterError && error.code === "config_invalid");
});

test("execution target identity includes configured host", () => {
  const remote = VALID.replace('id = "alpha"', 'id = "remote"').replace('label = "Alpha"', 'label = "Remote"') + 'ssh_host="server"\n';
  assert.equal(parseConfig(VALID + remote).agents.length, 2);
  assert.throws(() => parseConfig(VALID + remote.replace('ssh_host="server"', '')),
    (error: unknown) => error instanceof RouterError && error.code === "config_invalid");
});


test("source normalization reflects recipient edits instead of stale parsed bindings", () => {
  const route = parseConfig(VALID + SENDBLUE_GATEWAY).gateway!.routes[0]!;
  const before = routeSources(route);
  route.sender = "+15125550300";
  const after = routeSources(route);
  assert.notDeepEqual(after, before);
  assert.equal(after[0]!.kind, "sendblue");
  if (after[0]!.kind === "sendblue") assert.equal(after[0]!.sender, route.sender);
});

test("Sendblue defaults to polling without public URL or webhook secret", () => {
  const source = SENDBLUE_GATEWAY.replace('mode = "webhook"', '').replace('public_url = "https://gateway.example.com"', '').replace('webhook_secret_env = "SB_WEBHOOK"', '');
  const gateway = parseConfig(VALID + source).gateway!;
  assert.equal(gateway.sendblue[0]!.mode, "poll");
  assert.equal(gateway.sendblue[0]!.webhookSecretEnv, undefined);
  assert.equal(gateway.publicUrl, undefined);
  assert.equal(gateway.listenHost, "127.0.0.1");
  const start = parseConfig(VALID + source.replace('id = "personal"', 'id = "personal"\npoll_start="2026-09-27T02:00:00-05:00"')).gateway!;
  assert.equal(start.sendblue[0]!.pollStart, "2026-09-27T07:00:00.000Z");
  for (const extra of ['mode="invalid"', 'poll_start="yesterday"', 'poll_start="2026-02-30T00:00:00Z"', 'poll_start="2026-09-27"']) {
    assert.throws(() => parseConfig(VALID + source.replace('id = "personal"', `id = "personal"\n${extra}`)), (error: unknown) => error instanceof RouterError && error.code === "config_invalid");
  }
  assert.throws(() => parseConfig(VALID + SENDBLUE_GATEWAY.replace('webhook_secret_env = "SB_WEBHOOK"', '')), (error: unknown) => error instanceof RouterError && error.code === "config_invalid");
  assert.throws(() => parseConfig(VALID + SENDBLUE_GATEWAY.replace('mode = "webhook"', 'mode="webhook"\npoll_start="2026-09-27T00:00:00Z"')), (error: unknown) => error instanceof RouterError && error.code === "config_invalid");
});

test("LAN listener requires a specific private IPv4 address and TLS paths", () => {
  const configured = (extra: string) => VALID + HTTPS_GATEWAY.replace('listen_port = 8787', `listen_port = 8787\n${extra}`);
  const tls = 'tls={cert="/tmp/server.crt",key="/tmp/server.key"}';
  for (const host of ["10.1.2.3", "172.16.0.5", "172.31.255.5", "192.168.1.5"]) {
    const gateway = parseConfig(configured(`listen_host="${host}"\n${tls}`)).gateway!;
    assert.equal(gateway.listenHost, host);
    assert.deepEqual(gateway.tls, { certPath: "/tmp/server.crt", keyPath: "/tmp/server.key" });
    assert.throws(() => parseConfig(configured(`listen_host="${host}"`)), (error: unknown) => error instanceof RouterError && error.code === "config_invalid");
  }
  for (const host of ["0.0.0.0", "::", "::1", "localhost", "8.8.8.8", "172.15.0.1", "172.32.0.1", "169.254.1.1", "192.168.1.999"]) {
    assert.throws(() => parseConfig(configured(`listen_host="${host}"\n${tls}`)), (error: unknown) => error instanceof RouterError && error.code === "config_invalid");
  }
  for (const tls of ['tls={cert="relative.crt",key="/tmp/key"}', 'tls={cert="/tmp/cert"}', 'tls={cert="/tmp/cert",key="/tmp/key",insecure=true}']) {
    assert.throws(() => parseConfig(configured(tls)), (error: unknown) => error instanceof RouterError && error.code === "config_invalid");
  }
});
