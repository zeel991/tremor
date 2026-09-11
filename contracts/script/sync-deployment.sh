#!/usr/bin/env bash
# Copy deployments/<chainId>.json -> web/src/config/deployment.json (ARCHITECTURE.md §0 Config).
#   ./script/sync-deployment.sh 31337
set -euo pipefail
cd "$(dirname "$0")/.."

CHAIN_ID="${1:-}"
if [ -z "$CHAIN_ID" ]; then
  RPC="${RPC:-http://127.0.0.1:8545}"
  CHAIN_ID=$(cast chain-id --rpc-url "$RPC" 2>/dev/null) || { echo "usage: $0 <chainId>"; exit 1; }
fi
case "$CHAIN_ID" in ''|*[!0-9]*) echo "not a chain id: $CHAIN_ID"; exit 1;; esac

SRC="deployments/$CHAIN_ID.json"
DEST="../web/src/config/deployment.json"
[ -f "$SRC" ] || { echo "no manifest at $SRC (run Deploy.s.sol first)"; exit 1; }

python3 - "$SRC" "$CHAIN_ID" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
if str(d.get("chainId")) != sys.argv[2]:
    print("manifest chainId %s != %s" % (d.get("chainId"), sys.argv[2])); sys.exit(1)
if d.get("schemaVersion") != 3:
    print("manifest schemaVersion %s != 3 (older manifests must not be read as v3)" % d.get("schemaVersion")); sys.exit(1)
required = ["chainId","aqua","weth","usdc","feed","router","routerBytecodeHash","seriesFactory","marketEngine","portfolioMarket","portfolioAccumulator",
            "accumulator","seriesDeployer","programs","lens","oracle","deploymentBlock","writer","buyer"]
missing = [k for k in required if k not in d]
zero = [k for k in required
        if k not in ("chainId","deploymentBlock","routerBytecodeHash")
        and str(d.get(k,"")).lower() == "0x"+"0"*40]
if missing or zero:
    print("manifest incomplete: missing=%s zero=%s" % (missing, zero)); sys.exit(1)
PY

mkdir -p "$(dirname "$DEST")"
cp "$SRC" "$DEST"
if [ -f "../web/src/config/deployment-${CHAIN_ID}.json" ]; then
  cp "$SRC" "../web/src/config/deployment-${CHAIN_ID}.json"
fi
echo "synced $SRC -> $DEST and deployment-${CHAIN_ID}.json"
python3 -c "import json;d=json.load(open('$DEST'));print('  chain %s  router %s  controller %s  lens %s  block %s'%(d['chainId'],d['router'],d['seriesFactory'],d['lens'],d['deploymentBlock']))"
