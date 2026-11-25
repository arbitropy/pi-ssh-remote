#!/usr/bin/env bash
# Run the real pi in the isolated mock environment (HOME, PI_CODING_AGENT_DIR from mock-env.sh).
# Extra args are passed to pi (e.g. --mode rpc --no-session, -p "prompt").
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
eval "$("$HERE/mock-env.sh" env)"
SECRETS="${PI_SECRETS_ENV:-/mnt/data/work/Personal/pi-env/secrets.env}"
if [[ -f $SECRETS ]]; then set -a; . "$SECRETS"; set +a; fi
cd "$MOCK_LOCAL_PROJECT"
# --approve trusts project-local files (.pi/ etc.) for this run so no trust prompt blocks automation.
exec "$PI_BIN" --approve --no-extensions -e "$PI_SSH_EXT" "$@"
