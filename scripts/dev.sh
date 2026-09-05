#!/usr/bin/env bash
# ============================================================================
# Tremor — bring up the whole local stack with one command.
#
#   scripts/dev.sh              reuse healthy services, start the rest
#   scripts/dev.sh --fresh      re-fork the chain and redeploy + reseed from scratch
#   scripts/dev.sh --no-seed    deploy the contracts but skip the demo lifecycle
#
# Order matters: the chain must exist before contracts deploy, the manifest must
# exist before the API can index, and the web app reads both. Each step is
# skipped when it is already satisfied, so re-running this is cheap.
#
# The script stays attached in the foreground. Services it starts are stopped on
# exit; healthy services that were already running are left alone.
# ============================================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"

RPC_PORT=${RPC_PORT:-8545}
RPC=${RPC:-http://127.0.0.1:$RPC_PORT}
CHAIN=${CHAIN:-31337}
BASE_RPC_URL=${BASE_RPC_URL:-https://mainnet.base.org}
API_PORT=${API_PORT:-8787}
WEB_PORT=${WEB_PORT:-3000}
# Base-fork defaults. Export them so the no-seed Deploy script uses the same canonical
# Aqua, WETH, USDC and Chainlink contracts as the seeded demo path.
export AQUA=${AQUA:-0x1111113ccf1426a8e30e2bff5e005d929bf6a90a}
export WETH=${WETH:-0x4200000000000000000000000000000000000006}
export USDC=${USDC:-0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913}
export FEED=${FEED:-0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70}
LOGS="$ROOT/.dev-logs"
mkdir -p "$LOGS"

FRESH=0
SEED=1
usage() {
  printf '%s\n' \
    'Usage: scripts/dev.sh [--fresh] [--no-seed]' \
    '' \
    '  --fresh    restart the local fork, redeploy, and reseed' \
    '  --no-seed  deploy contracts without creating demo series' \
    '  -h, --help show this help' \
    '' \
    'Environment: RPC, RPC_PORT, CHAIN, BASE_RPC_URL, API_PORT, WEB_PORT'
}
for a in "$@"; do
  case "$a" in
    --fresh) FRESH=1 ;;
    --no-seed) SEED=0 ;;
    -h|--help) usage; exit 0 ;;
    *) echo "unknown flag: $a" >&2; usage >&2; exit 2 ;;
  esac
done

STARTED_ANVIL=0
STARTED_API=0
ANVIL_PID=""
API_PID=""
WEB_PID=""

cleanup() {
  trap - EXIT INT TERM
  [ -n "$WEB_PID" ] && kill "$WEB_PID" 2>/dev/null || true
  [ "$STARTED_API" = "1" ] && [ -n "$API_PID" ] && kill "$API_PID" 2>/dev/null || true
  [ "$STARTED_ANVIL" = "1" ] && [ -n "$ANVIL_PID" ] && kill "$ANVIL_PID" 2>/dev/null || true
  [ -n "$WEB_PID" ] && wait "$WEB_PID" 2>/dev/null || true
  [ -n "$API_PID" ] && wait "$API_PID" 2>/dev/null || true
  [ -n "$ANVIL_PID" ] && wait "$ANVIL_PID" 2>/dev/null || true
}
on_signal() { exit 130; }
trap cleanup EXIT
trap on_signal INT TERM

step() { printf '\n\033[1m── %s\033[0m\n' "$1"; }
listening() { lsof -iTCP:"$1" -sTCP:LISTEN -n -P >/dev/null 2>&1; }
need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ missing required command: $1" >&2; exit 1; }; }
web_is_tremor() {
  local body
  body=$(curl -fsS -m 5 "http://localhost:$WEB_PORT/" 2>/dev/null) || return 1
  [[ "$body" == *"<title>Tremor"* ]]
}

for cmd in anvil cast forge cargo curl lsof npm python3; do need "$cmd"; done

# ---------------------------------------------------------------- 1. chain
step "1/5  anvil — Base fork on :$RPC_PORT"
if [ "$FRESH" = "1" ] && listening "$RPC_PORT"; then
  OLD_NODE_PID=$(lsof -iTCP:"$RPC_PORT" -sTCP:LISTEN -n -P -t 2>/dev/null | sed -n '1p')
  OLD_NODE_CMD=$(ps -p "$OLD_NODE_PID" -o comm= 2>/dev/null || true)
  if [[ "$OLD_NODE_CMD" != *anvil* ]]; then
    echo "✗ --fresh will not stop $OLD_NODE_CMD on RPC port $RPC_PORT; free the port manually" >&2
    exit 1
  fi
  echo "  --fresh: stopping the running node"
  kill "$OLD_NODE_PID"
  sleep 2
fi
if listening "$RPC_PORT"; then
  ACTIVE_CHAIN=$(cast chain-id --rpc-url "$RPC" 2>/dev/null || true)
  if [ -z "$ACTIVE_CHAIN" ]; then
    echo "✗ port $RPC_PORT is occupied, but $RPC is not a JSON-RPC endpoint" >&2
    exit 1
  fi
  if [ "$ACTIVE_CHAIN" != "$CHAIN" ]; then
    echo "✗ RPC reports chain $ACTIVE_CHAIN, but CHAIN is $CHAIN" >&2
    exit 1
  fi
  echo "  already up (block $(cast block-number --rpc-url "$RPC" 2>/dev/null || echo '?'))"
else
  anvil --fork-url "$BASE_RPC_URL" --chain-id "$CHAIN" --auto-impersonate --port "$RPC_PORT" > "$LOGS/anvil.log" 2>&1 &
  ANVIL_PID=$!
  STARTED_ANVIL=1
  printf '  forking %s ' "$BASE_RPC_URL"
  until cast chain-id --rpc-url "$RPC" >/dev/null 2>&1; do
    kill -0 "$ANVIL_PID" 2>/dev/null || { echo; echo "✗ anvil died — see $LOGS/anvil.log"; exit 1; }
    printf '.'; sleep 1
  done
  echo " up (block $(cast block-number --rpc-url "$RPC"))"
fi

# ---------------------------------------------------------------- 2. contracts
step "2/5  contracts"
NEED_DEPLOY=1
MANIFEST="contracts/deployments/$CHAIN.json"
if [ "$FRESH" = "0" ] && [ -f "$MANIFEST" ]; then
  CONTROLLER=$(python3 -c "import json;print(json.load(open('$MANIFEST'))['seriesFactory'])" 2>/dev/null || echo "")
  # A manifest can outlive the chain it describes (restarted anvil), so trust code, not the file.
  if [ -n "$CONTROLLER" ] && [ "$(cast code "$CONTROLLER" --rpc-url "$RPC" 2>/dev/null)" != "0x" ]; then
    NEED_DEPLOY=0
    echo "  already deployed — controller $CONTROLLER"
  fi
fi
if [ "$NEED_DEPLOY" = "1" ]; then
  if [ "$SEED" = "1" ]; then
    echo "  deploying and seeding two demo series (this settles from real Chainlink history — takes a minute)"
    DEMO_LOG="$LOGS/demo.log"
    if ! ( cd contracts && FORCE_DEPLOY=1 ./script/demo.sh ) >"$DEMO_LOG" 2>&1; then
      grep -E "STAGE|✗|Error|revert|panic" "$DEMO_LOG" | tail -30 || true
      echo "✗ contract demo failed — see $DEMO_LOG"
      exit 1
    fi
    grep -E "STAGE|DEMO COMPLETE|redeploying" "$DEMO_LOG" || true
  else
    echo "  deploying (no seed data)"
    ( cd contracts && forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast \
        --private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 >/dev/null 2>&1 )
  fi
  [ -f "$MANIFEST" ] || { echo "✗ deploy produced no $MANIFEST"; exit 1; }
fi
# forge chatters warnings and lint notes on stderr; keep them in the log, not the terminal.
if ! ( cd contracts && ./script/sync-deployment.sh "$CHAIN" && ./script/export-abi.sh ) \
     > "$LOGS/contracts.log" 2>&1; then
  echo "✗ syncing the manifest / ABIs failed — see $LOGS/contracts.log"; exit 1
fi
echo "  manifest synced to web/src/config, ABIs exported to web + backend"

# ---------------------------------------------------------------- 3. api
step "3/5  Rust API on :$API_PORT"
API_BUILT=0
# A fresh deployment invalidates every indexed row: the series ids, the order hashes and the vault
# addresses all belong to contracts that no longer exist. The schema is versioned and the backend
# refuses to start against an older one, so a redeploy always rebuilds the database from the chain.
API_RESET=""
if [ "$NEED_DEPLOY" = "1" ]; then API_RESET="--reset-db"; fi
API_BINARY="backend/target/release/tremor-api"
if listening "$API_PORT" && [ -x "$API_BINARY" ]; then
  NEWER_BACKEND_SOURCE=$(find backend/src backend/abi backend/Cargo.toml backend/Cargo.lock -type f -newer "$API_BINARY" -print -quit 2>/dev/null || true)
  if [ -n "$NEWER_BACKEND_SOURCE" ]; then
    RUNNING_API_PID=$(lsof -iTCP:"$API_PORT" -sTCP:LISTEN -n -P -t 2>/dev/null | sed -n '1p')
    RUNNING_API_CMD=$(ps -p "$RUNNING_API_PID" -o comm= 2>/dev/null || true)
    if [[ "$RUNNING_API_CMD" != *tremor-api* ]]; then
      echo "✗ backend changed, but port $API_PORT belongs to $RUNNING_API_CMD" >&2
      exit 1
    fi
    echo "  backend changed — rebuilding and refreshing the API"
    ( cd backend && cargo build --release 2>&1 | tail -2 )
    API_BUILT=1
    kill "$RUNNING_API_PID"
    for _ in $(seq 1 40); do
      listening "$API_PORT" || break
      sleep 0.25
    done
  fi
fi
# A running API is indexing the contracts that were just replaced, so it has to be restarted too.
if [ -n "$API_RESET" ] && listening "$API_PORT"; then
  RUNNING_API_PID=$(lsof -iTCP:"$API_PORT" -sTCP:LISTEN -n -P -t 2>/dev/null | sed -n '1p')
  RUNNING_API_CMD=$(ps -p "$RUNNING_API_PID" -o comm= 2>/dev/null || true)
  if [[ "$RUNNING_API_CMD" == *tremor-api* ]]; then
    echo "  contracts were redeployed — restarting the API and rebuilding its index"
    kill "$RUNNING_API_PID"
    for _ in $(seq 1 40); do
      listening "$API_PORT" || break
      sleep 0.25
    done
  fi
fi
if listening "$API_PORT"; then
  API_CHAIN=$(curl -fsS -m 3 "http://localhost:$API_PORT/health" 2>/dev/null | python3 -c 'import json,sys; print(json.load(sys.stdin)["chain_id"])' 2>/dev/null || true)
  if [ "$API_CHAIN" = "$CHAIN" ]; then
    echo "  already up"
  elif [ -n "$API_CHAIN" ]; then
    echo "✗ Tremor API on port $API_PORT indexes chain $API_CHAIN, but CHAIN is $CHAIN" >&2
    exit 1
  else
    echo "✗ port $API_PORT is occupied, but it is not a healthy Tremor API" >&2
    exit 1
  fi
else
  # Cargo's incremental build is cheap when nothing changed and guarantees the
  # server never starts an executable left over from older source code.
  if [ "$API_BUILT" = "0" ]; then
    echo "  checking the release binary"
    ( cd backend && cargo build --release 2>&1 | tail -2 )
  fi
  ( cd backend && RPC_URL="$RPC" DEPLOYMENT_JSON="../$MANIFEST" DATABASE_URL=sqlite://tremor.db \
      PORT="$API_PORT" CORS_ORIGIN="http://localhost:$WEB_PORT" exec ./target/release/tremor-api $API_RESET ) > "$LOGS/api.log" 2>&1 &
  API_PID=$!
  STARTED_API=1
  printf '  starting '
  API_READY=0
  for _ in $(seq 1 60); do
    if curl -fsS -m 2 "http://localhost:$API_PORT/health" >/dev/null 2>&1; then
      API_READY=1
      break
    fi
    kill -0 "$API_PID" 2>/dev/null || { echo; echo "✗ API died — see $LOGS/api.log"; exit 1; }
    printf '.'; sleep 1
  done
  if [ "$API_READY" = "0" ]; then
    echo
    echo "✗ API did not become healthy within 60 seconds — see $LOGS/api.log"
    exit 1
  fi
  echo " up"
fi
curl -s -m 5 "http://localhost:$API_PORT/health" | python3 -c \
  "import json,sys;d=json.load(sys.stdin);print(f\"  chain {d['chain_id']} · indexed block {d['indexed_block']} · {d['series_indexed']} series\")" 2>/dev/null || true

# ---------------------------------------------------------------- 4. web deps
step "4/5  web dependencies"
if [ -d web/node_modules ]; then
  echo "  present"
elif [ -f web/package-lock.json ]; then
  ( cd web && npm ci )
else
  ( cd web && npm install )
fi

# ---------------------------------------------------------------- 5. web
step "5/5  Next.js on :$WEB_PORT  (foreground — Ctrl-C stops the stack)"
if listening "$WEB_PORT"; then
  if web_is_tremor; then
    HOLDER=$(lsof -iTCP:"$WEB_PORT" -sTCP:LISTEN -n -P 2>/dev/null | awk 'NR==2 {print $1" (pid "$2")"}')
    echo "  already up (${HOLDER:-existing web server})"
  else
    echo "✗ port $WEB_PORT is occupied, but it is not serving a healthy web app" >&2
    exit 1
  fi
else
  (
    export NEXT_PUBLIC_API_URL="http://localhost:$API_PORT"
    export NEXT_PUBLIC_RPC_URL="$RPC"
    export NEXT_PUBLIC_CHAIN_ID="$CHAIN"
    cd web
    exec ./node_modules/.bin/next dev --port "$WEB_PORT"
  ) &
  WEB_PID=$!
fi
echo "  chain    $RPC"
echo "  api      http://localhost:$API_PORT"
echo "  web      http://localhost:$WEB_PORT"
echo
if [ -n "$WEB_PID" ]; then
  wait "$WEB_PID"
else
  echo "  attached to the existing web server — Ctrl-C stops only services started here"
  while listening "$WEB_PORT"; do
    sleep 2 &
    wait $!
  done
  echo "✗ the reused web server stopped" >&2
  exit 1
fi
