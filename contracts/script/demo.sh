#!/usr/bin/env bash
# Tremor v2 fork demo. Prerequisite:
#   anvil --fork-url https://mainnet.base.org --chain-id 31337 --auto-impersonate --port 8545
#
# Deploys the v2 stack against canonical Aqua, real Circle USDC and the real Chainlink ETH/USD proxy,
# funds anvil accounts 0/1/2 with USDC by impersonating a large holder, then runs six stages:
#
#   A  protected writer vault: create, deposit, create a forward series, ship ISSUE/EXIT/SETTLE
#   B  issuance: buyers take receipts, exactly the sold units' liability locks
#   C  the three writer attacks, each failing on chain
#   D  a real pre-expiry exit at the executable bid
#   E  a back-dated series: bounded permissionless checkpoints of real Chainlink history, finalize, redeem, close
#   F  trailing realized variance for the LVR page
#
# Every stage asserts its own claims inside DemoFlow.s.sol and aborts loudly. Ends with DEMO COMPLETE.
set -euo pipefail
cd "$(dirname "$0")/.."

RPC=${RPC:-http://127.0.0.1:8545}
PK0=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80   # anvil #0 = writer/deployer
ACC0=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266                          # writer
ACC1=0x70997970C51812dc3A010C7d01b50e0d17dc79C8                          # buyer1
ACC2=0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC                          # buyer2 / unprivileged keeper
USDC=0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913
USDC_WHALE=0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB                    # Aave aUSDC (impersonated)
export AQUA=${AQUA:-0x1111113ccf1426a8e30e2bff5e005d929bf6a90a}
export WETH=${WETH:-0x4200000000000000000000000000000000000006}
export USDC
export FEED=${FEED:-0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70}
export WRITER=$ACC0
export BUYER=$ACC1
# Recorded in the manifest so a deployment can be traced back to the exact official router source.
export ROUTER_SOURCE_COMMIT=${ROUTER_SOURCE_COMMIT:-$(git -C lib/swap-vm rev-parse HEAD 2>/dev/null || echo unrecorded)}

stage() { echo; echo "════════ $1 ════════"; }
run() {
  local out
  if ! out=$(forge script script/DemoFlow.s.sol --rpc-url "$RPC" --broadcast --slow --sig "$1" -vv 2>&1); then
    echo "$out" | grep -E "Error|revert|Revert|require|panic|ATTACK SUCCEEDED" | head -20
    echo "$out" | tail -30
    echo "✗ STAGE FAILED: $1"; exit 1
  fi
  echo "$out" | grep -E "^\s*(STAGE|  )" || true
}
# Attack stages run WITHOUT --broadcast: a reverting transaction cannot be broadcast, which is the finding.
simulate() {
  local out
  if ! out=$(forge script script/DemoFlow.s.sol --rpc-url "$RPC" --sig "$1" -vv 2>&1); then
    echo "$out" | grep -E "Error|revert|Revert|require|panic|ATTACK SUCCEEDED" | head -20
    echo "$out" | tail -30
    echo "✗ STAGE FAILED: $1"; exit 1
  fi
  echo "$out" | grep -E "^\s*(STAGE|  )" || true
}

run_p() {
  local out
  if ! out=$(forge script script/PortfolioDemoFlow.s.sol --rpc-url "$RPC" --broadcast --slow --sig "$1" -vv 2>&1); then
    echo "$out" | grep -E "Error|revert|Revert|require|panic" | head -20
    echo "$out" | tail -30
    echo "✗ STAGE FAILED: $1"; exit 1
  fi
  echo "$out" | grep -E "^\s*(P[0-9]|    )" || true
}
simulate_p() {
  local out
  if ! out=$(forge script script/PortfolioDemoFlow.s.sol --rpc-url "$RPC" --sig "$1" -vv 2>&1); then
    echo "$out" | grep -E "Error|revert|Revert|require|panic" | head -20
    echo "$out" | tail -30
    echo "✗ STAGE FAILED: $1"; exit 1
  fi
  echo "$out" | grep -E "^\s*(P[0-9]|    )" || true
}

CHAIN=$(cast chain-id --rpc-url "$RPC") || { echo "anvil not reachable at $RPC"; exit 1; }
[ "$CHAIN" = "31337" ] || { echo "refusing to run demo on chain $CHAIN (expected local 31337)"; exit 1; }

stage "FUND — impersonate aUSDC, send 1,000,000 USDC to anvil accounts 0/1/2"
cast rpc anvil_setBalance $USDC_WHALE 0x56BC75E2D63100000 --rpc-url "$RPC" >/dev/null
for a in $ACC0 $ACC1 $ACC2; do
  cast send --unlocked --from $USDC_WHALE $USDC "transfer(address,uint256)" $a 1000000000000 --rpc-url "$RPC" >/dev/null
  echo "  $a USDC: $(cast call $USDC 'balanceOf(address)(uint256)' $a --rpc-url "$RPC")"
done

# Deploy when the manifest is missing, when it is not schema v2, when the addresses it names have no code
# on THIS chain (anvil restarted under a stale manifest), or when forced.
NEEDS_DEPLOY=0
if [ ! -f "deployments/$CHAIN.json" ]; then
  NEEDS_DEPLOY=1
else
  SCHEMA=$(python3 -c "import json;print(json.load(open('deployments/$CHAIN.json')).get('schemaVersion',0))" 2>/dev/null || echo 0)
  FACTORY_ADDR=$(python3 -c "import json;print(json.load(open('deployments/$CHAIN.json')).get('seriesFactory',''))" 2>/dev/null || echo "")
  if [ "$SCHEMA" != "3" ]; then
    echo "  ! deployments/$CHAIN.json is schema $SCHEMA, not 3 — redeploying."
    NEEDS_DEPLOY=1
  elif [ -z "$FACTORY_ADDR" ] || [ "$(cast code "$FACTORY_ADDR" --rpc-url "$RPC" 2>/dev/null)" = "0x" ]; then
    echo "  ! deployments/$CHAIN.json names $FACTORY_ADDR which has no code on this chain — redeploying."
    NEEDS_DEPLOY=1
  fi
fi
if [ "$NEEDS_DEPLOY" = "1" ] || [ "${FORCE_DEPLOY:-0}" = "1" ]; then
  # The router is deployed with `forge create` rather than from inside the script: forge's broadcast
  # bookkeeping cannot decode this constructor's two string arguments when the contract comes from a
  # dependency, and the whole broadcast is abandoned. Same source, same compiler settings, same bytecode —
  # `Deploy.s.sol` then verifies the address has code and records its bytecode hash in the manifest.
  stage "DEPLOY ROUTER — unmodified official AquaSwapVMRouter from lib/swap-vm @ $ROUTER_SOURCE_COMMIT"
  ROUTER_OUT=$(mktemp)
  if ! forge create --rpc-url "$RPC" --private-key "$PK0" --broadcast \
        lib/swap-vm/src/routers/AquaSwapVMRouter.sol:AquaSwapVMRouter \
        --constructor-args "$AQUA" "$WETH" "$ACC0" SwapVM 1 >"$ROUTER_OUT" 2>&1; then
    tail -20 "$ROUTER_OUT"; rm -f "$ROUTER_OUT"; echo "✗ router deployment failed"; exit 1
  fi
  export ROUTER=$(grep -Eo 'Deployed to: 0x[0-9a-fA-F]{40}' "$ROUTER_OUT" | awk '{print $3}')
  rm -f "$ROUTER_OUT"
  [ -n "${ROUTER:-}" ] || { echo "✗ could not read the router address"; exit 1; }
  echo "  router $ROUTER"

  stage "DEPLOY — controller (accumulator, engine, deployer) + programs + lens + oracle"
  DEPLOY_OUT=$(mktemp)
  if ! forge script script/Deploy.s.sol --rpc-url "$RPC" --broadcast --private-key "$PK0" -vv >"$DEPLOY_OUT" 2>&1; then
    grep -E "Error|revert|Revert|require|panic" "$DEPLOY_OUT" | head -20 || true
    tail -30 "$DEPLOY_OUT"
    rm -f "$DEPLOY_OUT"
    echo "✗ deployment failed"
    exit 1
  fi
  grep -E "^\s*(DEPLOY|  )" "$DEPLOY_OUT" || true
  rm -f "$DEPLOY_OUT"
  [ -f "deployments/$CHAIN.json" ] || { echo "✗ deploy did not write deployments/$CHAIN.json"; exit 1; }
fi
cat "deployments/$CHAIN.json"

stage "STAGE A — protected writer vault, forward series, all three Aqua strategies shipped, nothing reserved"
run "stageA()"

stage "STAGE B — issuance: buyer1 takes 20 units, buyer2 takes 10 at a higher ask; sold-unit liability locks"
run "stageB()"

stage "STAGE C — writer attacks (simulated, because a reverting transaction cannot be broadcast)"
simulate "stageCAttacks()"

stage "STAGE C+ — what the writer legitimately can do: take the premiums, and nothing else"
run "stageCLegitimate()"

stage "STAGE D — buyer1 exits 8 units before expiry at the executable bid; receipts burn, liability releases"
run "stageD()"

stage "STAGE E — back-dated series: bounded permissionless checkpoints of REAL Chainlink history, finalize, redeem, close"
run "stageE()"

stage "STAGE F — warm the trailing realized-variance cache the LVR page reads"
run "stageF()"

stage "STAGE P1 — portfolio group: writer funds a protected vault with \$100 and opens one HIGH/CALM risk group"
run_p "stageP1()"

stage "STAGE P2 — buyer1 buys 100 HIGH for \$30; the full \$100 cap locks"
run_p "stageP2()"

stage "STAGE P3 — buyer2 buys 100 CALM for \$75; the reserve DOES NOT MOVE (\$100, not \$200)"
run_p "stageP3()"

stage "STAGE P4 — the writer withdraws every free cent (premiums are not backing)"
run_p "stageP4()"

stage "STAGE P4A — the \$5 buyback of 20 HIGH reverts ExitUnderfunded (simulated: reverts cannot be broadcast)"
simulate_p "stageP4Attack()"

stage "STAGE P5 — the writer locks a \$5 exit buffer; the same buyback executes"
run_p "stageP5()"

stage "STAGE P6 — back-dated group: real Chainlink history, one finalization fixes BOTH payouts, both redeem"
run_p "stageP6()"

stage "SYNC + ABI"
./script/sync-deployment.sh "$CHAIN"
./script/export-abi.sh

echo; echo "DEMO COMPLETE ✓"
