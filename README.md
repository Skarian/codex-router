# Codex Router

Codex Router sends text to existing Codex tasks from the command line. Add a
short local name for each task, then send instructions from Termux, shell
scripts, voice workflows, or other clients.

```sh
echo 'Check the latest changes and run the tests.' |
  codex-router send main --stdin --json
```

```json
{"type":"completed","text":"The tests pass."}
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
id = "main"
label = "Main"
cwd = "/data/data/com.termux/files/home/projects/main"
thread_id = "019..."
model = "gpt-5.3-codex-spark"
reasoning = "medium"
```

`id`, `label`, `cwd`, `thread_id`, and `model` are required. `reasoning` is
optional; Codex uses the model's default effort when you leave it out.

Each send resumes the configured task in its configured directory. Turns run
with full access and approvals disabled.

## Use

```sh
codex-router agents list
codex-router doctor

printf '%s' 'Summarize the current state.' |
  codex-router send main --stdin
```

Use `--json` for one final JSON object. Use `--stream` for completed reasoning,
commentary, and final messages as JSON Lines.

Codex Router connects to the app-server used by native remote control when its
standard control socket is available. Otherwise, it starts an app-server for
the command and closes it afterward.

See [CLI reference](docs/cli-reference.md) for commands, output shapes, exit
codes, and failure codes.

## Develop

```sh
npm ci
npm test
```
