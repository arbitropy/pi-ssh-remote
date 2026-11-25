<!--
Agent-first English documentation for pi-ssh-remote. It explains the extension's design, transparent tool routing, persistent workspace model, safety boundaries, compelling workflows, commands, and installation requirements.
-->

# pi-ssh-remote

**SSH designed for agents—not just for terminals.**

[中文文档](README.zh-CN.md) · [Community](https://linux.do/)

`pi-ssh-remote` keeps a catalog of named **remote projects** and lets Pi focus on one. While a remote project has the focus, the agent keeps using its normal `read`, `write`, `edit`, `bash`, `grep`, `find`, and `ls` tools, but they run on that server. There is no need to wrap every action in `ssh ...`, copy files back and forth, or make the model reason about two unrelated shells.

```text
You: Connect to befaq-prod, find why the latest deploy failed, fix it on
     the server, and tell me what you changed.

Pi:  remote connect befaq-prod → reads logs → edits remote files →
     runs the tests on the server
```

## Designed for agent workflows

### Named remote projects, shared by every session

A remote project is a name plus an SSH command and a working directory, for example `befaq-prod` = `ssh befaq-prod` in `/opt/wifaq-production`, with an optional note, guard label, local checkout path, and port forwards. Projects are global: they are not tied to the folder Pi runs in, and they appear in every session. The agent finds them with `remote list` and connects by exact name; you manage them with `/remote add`, `/remote edit`, and `/remote remove`.

### Focus decides where tools run

Each session keeps an ordered list of the projects it has used and a **focus**: `local` or one of those projects. While a remote project has the focus, Pi's file tools, shell tool, and `!` user shell commands are transparently routed over SSH. Switching is explicit (`/remote focus NAME|local`), so the agent can compare two servers or hop back to the local checkout without reconnecting. If the focused project loses its connection and cannot reconnect, routed tools fail with a clear error; they never silently fall back to the local machine.

### Agent control plane, human control plane

The extension exposes `remote` for the agent and `/remote` for the user. You can ask Pi to connect, switch focus, change directory, run a command, create a tunnel, or return to local work in natural language, and still take direct control whenever you want.

### Resilient and bounded by default

Projects on the same host share one SSH connection. A dropped connection is re-established automatically while any connected project uses it. Sessions remember their project list: `/resume` restores it with every project disconnected and the focus on local (it never connects on its own), while `/reload`, `/new`, and forks reconnect the projects that were connected in the interactive TUI. Remote commands have a 30-second default timeout. Remote text reads fetch focused ranges instead of downloading complete files, command output is streamed through bounded buffers, and a 32 KB per-turn budget prevents parallel tools from flooding model context. Complete oversized command output is preserved in a permission-restricted temporary file.

### Hybrid local/remote workflows

Port forwards attach to a project's connection without changing the focus. This is useful when the backend runs on a GPU server but the client, browser automation, or integration code lives locally.

## Why not just run `ssh` in Bash?

| Plain SSH command | `pi-ssh-remote` |
|---|---|
| Each tool call must wrap or reconstruct SSH | All agent file and shell tools route automatically |
| Working directory is easy to lose between calls | Remote cwd is persistent and visible |
| The model must track whether it is local or remote | Pi's prompt and footer identify the active workspace |
| Disconnects break the workflow | Active-session connections automatically reconnect |
| Tunneling and remote editing are separate setups | Workspace routing and port forwarding share one control plane |
| Large output can flood context | Preview and model-output limits are built in |

## Install

```bash
pi install npm:pi-ssh-remote
```

Requires Node.js 20+. The remote server must provide Bash, SFTP, and GNU `timeout`.

## Quick start

```text
/remote add gpu-box "ssh -p 2202 root@gpu-box.example.com" /srv/project H100 training server
/remote connect gpu-box
/remote cd /srv/train
/remote status
```

`/remote add NAME SSH CWD [NOTE...]` saves a project (quote a full ssh command, or pass a bare target such as `tanim@islam30902` or an `~/.ssh/config` alias). `/remote connect gpu-box` connects and focuses it. From this point, normal Pi operations target the remote server. The footer shows the focus first, then other projects used in the session (`●` connected, `○` disconnected):

```text
gpu-box:/srv/train  ● befaq-prod  ○ staging
```

Switch tools back to this machine, or to another project, with:

```text
/remote focus local
/remote focus befaq-prod
```

`/remote ssh root@host -p 22` is a quick path: it finds or creates a project for that command (named after the alias or `user-host`, with cwd `~`) and connects.

### Project instructions

Pi loads `AGENTS.md` and `CLAUDE.md` only from the local folder tree, so a remote project's own instructions would never reach the model. While the focus is a connected remote project, this extension loads them from the remote and adds them to the system prompt, next to the local ones:

- **Discovery** follows Pi's own rule. For each directory from the project's current directory up to `/`, the first existing regular file among `AGENTS.override.md`, `AGENTS.md`, `AGENTS.MD`, `CLAUDE.md`, and `CLAUDE.MD` is used (so a directory with both `AGENTS.md` and `CLAUDE.md` contributes `AGENTS.md` only), outermost directory first. Pi's git-worktree shadowing rule is not reproduced.
- **Limits**: 32 KB per file and 64 KB in total (the nearest directories are kept first). A file cut by a limit ends with `[truncated: N of M bytes; read the file for the rest]`. A UTF-8 byte order mark is removed.
- **Labels**: remote files appear as `ssh://<project>/<absolute remote path>`, so the model can tell them from local files.
- **Refresh**: the files are fetched in one round trip when you connect, focus a project, change its directory (`/remote cd`, `chdir`), or after an automatic reconnect. Before an agent run, a copy older than 5 minutes is refreshed first, waiting at most 5 seconds; if the remote does not answer, the previous copy is used.
- **Visibility**: when the agent runs `remote` with `connect` or `focus` (or a `chdir` that changes the applicable files), the result lists the instructions and the project memory it just received, so they are in the transcript at the moment of the switch. The `/remote connect` and `/remote focus` commands print a one-line summary instead (`Loaded 2 instruction files and 1 memory entry for NAME`). `/remote status` lists the loaded files and the memory entry count.

### Project memory

Tell Pi what to remember for the focused project:

```text
Remember for this project: use /opt/conda/bin/python and never stop shared jobs.
```

List saved entries and their IDs:

```text
/remote memory [NAME]
```

Each project has its own file at `~/.pi/agent/ssh-remote-memories/projects/NAME.json`. While a remote project is focused and connected, its memory entries are part of the system prompt (the `ssh_remote_project_memory` section, together with the short instructions for editing the file), and only that project's memory is applied. Pi edits the file with its normal local tools. Use an ID to update or delete an entry:

```text
Update memory deploy-command to use /opt/deploy/v2/run.sh.
Delete memory obsolete-proxy-rule.
```

Deletion only happens when you explicitly request it. Removing a project keeps its memory file.

### Private key authentication

Pass an explicit local private key with `-i`:

```text
/remote ssh -i ~/.ssh/id_ed25519 root@gpu-box.example.com -p 2202
```

Identity paths must be absolute or start with `~/`. Unencrypted and passphrase-protected private keys are supported. Pi prompts for an encrypted key's passphrase and caches it only in the current process for reconnects; `/remote forget` clears it. When `-i` is present, that key is used exclusively instead of silently falling back to SSH agent or password authentication. Without `-i`, each host tries its SSH agent, configured or default key files, then a cached or prompted password. Default keys are `~/.ssh/id_ed25519`, `~/.ssh/id_ecdsa`, and `~/.ssh/id_rsa`; missing files are skipped.

### Jump hosts (ProxyJump)

Connect through one or more jump hosts without opening a local SSH tunnel:

```text
/remote ssh -J bastion@gateway.example.com:2222 developer@dev.internal
/remote ssh -J bastion@gateway.example.com,relay@relay.internal developer@dev.internal
/remote ssh -o ProxyJump=bastion@gateway.example.com developer@dev.internal
```

Each hop has its own host-key confirmation, SSH configuration, and authentication. `-i` applies only to the destination; jump hosts use their own configured/default keys or agent. Without command-line or config overrides, jump ports default to 22 and usernames default to the local user, not the destination user. Use brackets for IPv6 jump addresses, for example `user@[2001:db8::1]:2222`.

Reconnects rebuild the same route. Disconnect closes the whole chain; `/remote forget` also clears cached credentials for its jump hosts. Jump servers must allow TCP forwarding to the next host. No direct-connection fallback is attempted if a jump fails.

## Examples

### 1. Let the agent investigate and repair a remote failure

```text
Connect to befaq-prod and work in /opt/app. Inspect the failed deployment,
trace the error through the logs and source, make the smallest safe fix,
run the relevant tests, and show me the diff.
```

The agent calls `remote list`, then `remote connect befaq-prod`. Subsequent reads, searches, edits, and tests are ordinary Pi tool calls routed to the server.

### 2. Launch a long GPU job without blocking the agent

```text
On the focused remote project, validate the training command first. Then launch
it with nohup in the background, redirect stdout and stderr from process start,
and report the PID, output directory, and log path. Verify that the process is
still alive and that the log has started.
```

The default foreground timeout prevents an accidental long-running command from occupying the agent indefinitely, while an explicitly backgrounded job continues on the server.

### 3. Keep several machines understandable

```text
/remote add train "ssh root@10.0.0.21" /srv/train 8xH100 training
/remote add staging "ssh -p 2222 ubuntu@staging.example.com" /opt/service staging API
/remote edit staging guard=readonly local=/home/me/service
/remote list
/remote connect train
/remote connect staging
/remote focus train
```

Projects are saved globally, so every session sees them. Both stay connected; `/remote focus` moves the tools between them.

### 4. Expose a remote service while editing locally

```text
/remote edit train forwards="7860:127.0.0.1:7860"
/remote connect train
/remote forward
/remote focus local
```

`/remote forward` starts the focused project's saved `forwards` (or the mappings you pass). Forwards belong to the project's connection and never change the focus, so after `/remote focus local` `localhost:7860` still reaches the service on the SSH server while Pi's file and shell tools work on the local repository. Disconnecting the project, or `/remote unforward`, stops them.

### 5. Ask Pi directly

```text
Connect to the staging project, switch to /srv/api, and inspect its Git status.
```

```text
Save a project named prod-readonly for ssh deploy@prod.example.com in /srv/api
with the note "production, read-only", then focus it.
```

```text
Forward the remote service on port 8000 to localhost:8000, but keep my coding
tools on the local repository.
```

## Command reference

| Command | Purpose |
|---|---|
| `/remote` / `/remote list` | List saved projects (name, ssh, cwd, state, note) and the current focus, as copyable text |
| `/remote add NAME SSH CWD [NOTE...]` | Save a project; quote a full ssh command or pass a bare target |
| `/remote edit NAME key=value...` | Change `ssh`, `cwd`, `note`, `guard`, `local`, or `forwards`; `key=` clears an optional field. A value runs until the next `key=`, so `note=Staging server` needs no quotes |
| `/remote remove NAME` | Delete a saved project (its memory file is kept) |
| `/remote connect NAME` | Connect a project (exact name) and focus it |
| `/remote focus NAME\|local` | Send tools to a session project or back to local; a disconnected session project is reconnected |
| `/remote disconnect [NAME]` | Disconnect a project (default: the focused one); focus returns to local if it was focused |
| `/remote status` | Show the focus, the session's projects, and the focused project's loaded instruction files and memory entry count |
| `/remote memory [NAME]` | Show a project's memory entries, IDs, and file |
| `/remote cd PATH` | Change the focused project's working directory for this session |
| `/remote exec [--timeout S] [--lines N] COMMAND` | Run one command in the focused project |
| `/remote forward [MAPPING...]` | Forward local ports to the focused project's network (default: its saved `forwards`) |
| `/remote unforward` | Stop extension-managed forwards (the focused project's, or all when the focus is local) |
| `/remote forget [NAME]` | Disconnect and clear cached passwords and key passphrases for the project's hops |
| `/remote ssh ARGS...` | Quick path: find or create a project for `ssh ARGS...` (cwd `~`) and connect |
| `/remote config` | Show output limits, display lines, and the config path |
| `/remote config display-lines 10` | Set default collapsed preview lines (maximum 50) |
| `/remote config read-max-lines 400` / `read-max-bytes 16384` | Set the remote read budgets |
| `/remote config exec-max-lines 200` / `exec-max-bytes 8192` | Set the remote command budgets |
| `/remote config turn-max-bytes 32768` | Set the aggregate per-turn remote output budget |

Project names use lowercase letters, digits, `.`, `_`, and `-` (up to 64 characters, starting with a letter or digit); `local` is reserved. `guard` (`readonly` or `confirm`) and `local` (a local checkout path) are recorded and shown to the agent and in listings; enforcing guards is planned for a later release.

### The `remote` tool

The agent uses one tool with these actions: `list`, `add`, `edit`, `remove`, `connect`, `disconnect`, `focus`, `status`, `chdir`, `memory`, `forward`, `unforward`, `exec`, and `forget`. `connect` needs the exact project name; an unknown name returns a short list of similar saved projects. `remove` is only for explicit user requests. Passwords and key passphrases are never accepted as arguments.

### Slash-command completion

`/remote` supports Pi argument completion. Try `/remote sta` to complete `status`, or `/remote connect ` to choose from saved project names.

## Persistence, output, and security

Remote projects are stored locally in:

```text
~/.pi/agent/ssh-remote-config.json
```

```json
{
  "version": 2,
  "projects": {
    "befaq-prod": {
      "ssh": "ssh befaq-prod",
      "cwd": "/opt/wifaq-production",
      "note": "Production",
      "guard": "readonly",
      "local": "/home/me/wifaqdrf",
      "forwards": ["8080:127.0.0.1:80"]
    }
  },
  "displayLines": 5
}
```

`ssh` and `cwd` are required (`cwd` may be `~`); the other project fields are optional. The same file holds the preview setting and model-output budgets. Each Pi session also stores non-secret metadata (the focus and the session's projects with their current directories), so `/resume` can list them; it never reconnects by itself. Private key contents, passwords, and key passphrases are **never written to this file**. Private keys are read locally only when connecting; prompted passwords and passphrases remain only in process memory.

**Upgrading from 0.1.x:** the first start rewrites the old endpoint-based file in this shape. The original is copied to `ssh-remote-config.v1.backup.json` (only if that backup does not exist yet), each endpoint becomes one project named after its ssh alias (`ssh befaq-prod` becomes `befaq-prod`) or `user-host`, the active endpoint is dropped, and per-host memory is copied into `ssh-remote-memories/projects/NAME.json` (old files are left in place). A file that cannot be parsed is never overwritten.

New or changed host keys require interactive confirmation and are stored separately from OpenSSH. By default, remote text reads return at most 400 lines or 16 KB, remote command results return the last 200 lines or 8 KB, and all remote tools in one agent turn share a 32 KB output budget. Text reads support `offset`/`limit` continuation without downloading the complete remote file. Oversized command output is streamed to a permission-restricted temporary local file rather than accumulated in memory. Configured limits may be raised only to the extension's hard safety ceilings. Preview-line settings affect only the collapsed UI and never increase model output.

## Current SSH scope

Connections use the Node.js `ssh2` library; no local OpenSSH executable is required. Command options are `-p`, `-l`, `-i`, `-J`, and `-o ProxyJump=...` (including comma-separated jump chains).

`~/.ssh/config` supports `Host` patterns/negation, `HostName`, `User`, `Port`, `IdentityFile` (multiple entries), `IdentityAgent`, `IdentitiesOnly`, and `ProxyJump`. Command-line options take precedence, and every jump host is resolved independently. For example:

```sshconfig
Host gateway
    HostName gateway.example.com
    User bastion
    IdentityFile ~/.ssh/gateway_key

Host work
    HostName dev.internal
    User developer
    ProxyJump gateway
    IdentityFile ~/.ssh/work_key
```

Connect with `/remote ssh work`. Without `IdentityFile`, the default keys above are tried on each host, so ordinary `ssh -J ...` routes also work without an agent when both hosts accept a default key.

This is a supported subset, not full OpenSSH compatibility: system SSH config is not read; `Match` sections and applicable `Include`, `ProxyCommand`, or hostname canonicalization are rejected. Other config directives are not implemented. `IdentitiesOnly yes` disables agent authentication entirely; `IdentityAgent none` also disables it. Config key paths resolve relative to the home directory and support `~/` and `%d/%h/%n/%p/%r/%u/%%` tokens.

## Releases

Latest release: [v0.1.16](https://github.com/petrichor20211/pi-ssh-remote/releases/tag/v0.1.16)

| Version | Date | Highlights |
|---|---|---|
| [0.1.16](CHANGELOG.md#0116---2026-11-12) | 2026-11-12 | Disconnected sessions no longer advertise the saved SSH route, remote commands honor abort signals, and hosts without structured prompt options are supported |
| [0.1.15](CHANGELOG.md#0115---2026-10-11) | 2026-10-11 | Per-host SSH config and default-key discovery, route-preserving reconnects, and UI/autocomplete fixes |
| [0.1.14](CHANGELOG.md#0114---2026-09-28) | 2026-09-28 | ProxyJump connections, `/remote` argument completion, and clearer SSH tool routing |
| [0.1.13](CHANGELOG.md#0113---2026-09-18) | 2026-09-18 | Graceful working-directory fallback, longer SSH handshakes, and Windows path fixes |

See [CHANGELOG.md](CHANGELOG.md) for the complete release history, including additions, behavior changes, and bug fixes.

MIT licensed.

## Contributors

Thank you to all the people who have contributed to pi-ssh-remote!

<a href="https://github.com/petrichor20211/pi-ssh-remote/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=petrichor20211/pi-ssh-remote" alt="Contributors" />
</a>

Contributions are welcome: open an issue or a pull request on [GitHub](https://github.com/petrichor20211/pi-ssh-remote).
