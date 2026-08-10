# Codex Router

Codex Router sends text to existing Codex tasks from the command line. Add a
short local name for each task, then send instructions from shells, scripts,
voice workflows, or other clients.

```sh
echo 'Turn off the living room light.' |
  codex-router send home --stdin --json
```

```json
{"type":"completed","text":"The living room light is off."}
```

## Install

Codex Router requires Node.js 20 or newer and an authenticated Codex CLI.

```sh
npm install --global git+https://github.com/Skarian/codex-router.git
```

## Configure

Create `~/.codex-router.toml`:

```toml
[[agents]]
id = "home"
label = "Home Assistant"
cwd = "/home/user/projects/home-assistant"
thread_id = "019..."
model = "gpt-5.3-codex-spark"
reasoning = "medium"
```

`id`, `label`, `cwd`, `thread_id`, and `model` are required. `reasoning` is
optional; Codex uses the model's default effort when you leave it out.

To run an assistant on another machine, keep its complete configuration in
this file and add an SSH host:

```toml
[[agents]]
id = "server"
label = "Server Assistant"
ssh_host = "my-server"
cwd = "/home/user/projects/server"
thread_id = "019..."
model = "gpt-5.3-codex-spark"
```

The SSH host uses your existing OpenSSH configuration. The remote machine must
have an authenticated `codex` executable available to noninteractive SSH
sessions.

Each send resumes the configured task in its configured directory. Turns run
with full access and approvals disabled.

## Use

```sh
codex-router agents list
codex-router doctor

echo 'What is the thermostat set to?' |
  codex-router send home --stdin
```

Use `--json` for one final JSON object. Use `--stream` for completed reasoning,
commentary, and final messages as JSON Lines.

Codex Router connects to the app-server used by native remote control when its
standard control socket is available, including on configured SSH hosts.
Otherwise, it starts an app-server for the command and closes it afterward.

See [CLI reference](docs/cli-reference.md) for commands, output shapes, exit
codes, and failure codes.

## Develop

```sh
npm ci
npm test
```
