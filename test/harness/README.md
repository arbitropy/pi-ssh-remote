# pi-ssh-remote integration harness

Runs the real `pi` binary against three local mock SSH servers in an isolated pi profile
(own HOME and `PI_CODING_AGENT_DIR`), and can drive pi over its RPC mode.

## Mock environment

    test/harness/mock-env.sh up [--no-known-hosts]   # start sshds, (re)build fixtures; idempotent
    test/harness/mock-env.sh status
    test/harness/mock-env.sh down
    test/harness/mock-env.sh reset-state             # drop ssh-remote-config.json, memories, sessions
    eval "$(test/harness/mock-env.sh env)"           # export HOME, PI_CODING_AGENT_DIR, ...

Defaults: `MOCK_ROOT=/tmp/pi-ssh-mock`, `MOCK_PROVIDER=islam`, `MOCK_MODEL=qwen3.8-27b`,
`MOCK_MODELS_JSON=/mnt/data/work/Personal/pi-env/profiles/main/models.json`, `PI_BIN`, `PI_SSH_EXT`.

Servers (127.0.0.1, non-root sshd as the current user, pubkey only): `prod:2231`, `staging:2232`,
`bench:2233`. `echo $MOCK_HOST` on a remote prints the server name (sshd `SetEnv`). The remote
login home is your real home dir; project trees live under `$MOCK_ROOT/hosts/<name>/app`.

SSH aliases in the fake HOME (`$MOCK_ROOT/home/.ssh/config`): `mock-prod`, `mock-staging`,
`mock-bench` (key `keys/client`), and `mock-prod-enc` (same server as prod, key `keys/client_enc`,
passphrase `testpass`).

Known hosts: `up` preseeds `agent/ssh-remote-known-hosts.json` (hex SHA-256 of each host key blob, the
form ssh2 `hostHash: "sha256"` reports). `up --no-known-hosts` removes the file so the trust prompt appears.
No `ssh-remote-config.json` is created; tests add endpoints themselves.

## Interactive pi in the isolated env

    test/harness/pi.sh            # cwd = $MOCK_LOCAL_PROJECT, extension loaded via -e, --no-extensions, --approve
    test/harness/pi.sh -p "..."   # any pi args pass through

`--approve` trusts project-local files for the run so no trust prompt can block automation.
`pi-env/secrets.env` is sourced if present (override with `PI_SECRETS_ENV`).

## RPC driver

    node test/harness/rpc-driver.mjs script.json --out /tmp/run.jsonl [-- extra pi args]

    {
      "args": ["--no-session"],
      "timeoutMs": 600000,
      "ui": { "autoConfirm": true,
              "inputs":  { "passphrase": "testpass" },
              "selects": { "Choose": "Allow" },
              "cancel":  [] },
      "steps": [
        { "command": "/remote ssh mock-prod" },
        { "prompt": "free text (calls the model)" },
        { "abort_after_ms": 3000, "prompt": "..." },
        { "wait_idle": true }, { "get_state": true }, { "get_commands": true }, { "sleep_ms": 500 }
      ]
    }

- `command` and `prompt` are both sent as an RPC `prompt` message; a leading `/` runs an extension
  command. The driver checks `get_commands` first and refuses unknown slash commands, because pi would
  otherwise send them to the model as free text.
- Dialogs (`confirm`, `input`, `editor`, `select`) are answered per `ui`; unmatched ones are left unanswered
  (the extension's own 30 s dialog timeout then applies).
- stdout: per step `TOOL name args`, `-> result (isError)`, `NOTIFY`/`STATUS`/`UI` lines, `ASSISTANT:` final
  text, and step timing. `--out` gets every raw RPC record as JSONL (with a `_ts` ms field), plus
  `driver_step` markers; pi's stderr goes to `<out>.stderr`.
- Hard per-step timeout (default 600 s, per-step `timeoutMs`) kills pi, exit 3. Exit 1 = a step failed.
  A lock file (`$MOCK_ROOT/rpc-driver.lock`) prevents two drivers/pi processes at once.

## Fixtures

| Tree | Marker |
|---|---|
| `hosts/prod/app` | `PROD-MARKER-7731` (AGENTS.md); also `CLAUDE.md`: "Production rules: never restart services without approval." |
| `hosts/staging/app` | `STAGING-MARKER-7731` |
| `hosts/bench/app` | `BENCH-MARKER-7731` |
| `local/project` (pi cwd) | `LOCAL-MARKER-4410` |

Each remote app is a git repo (one commit) with `src/app.py` (has `def handle_payment(`),
`src/api/{__init__,views}.py`, `node_modules/junk.js` (must be excluded by find/grep), `big.txt` (~40 KB),
and `logs/error.log` (2000 lines; line 1500 = `ERROR PaymentGateway timeout ref=<name>-1500`).
