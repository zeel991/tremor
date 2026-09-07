#!/usr/bin/env bash
# Export ABI arrays (not full artifacts) to web/src/abi/<Name>.json and backend/abi/<Name>.json.
set -euo pipefail
cd "$(dirname "$0")/.."

forge build >/dev/null

WEB_DIR="../web/src/abi"
BE_DIR="../backend/abi"
mkdir -p "$WEB_DIR" "$BE_DIR"

# Preserve mtimes when an ABI is unchanged. The dev launcher uses those mtimes to decide
# whether the running backend must be rebuilt, so unconditional rewrites caused false restarts.
write_if_changed() {
  local target="$1" value="$2" tmp
  tmp=$(mktemp "${target}.tmp.XXXXXX")
  printf '%s\n' "$value" > "$tmp"
  if [ -f "$target" ] && cmp -s "$tmp" "$target"; then
    rm "$tmp"
  else
    mv "$tmp" "$target"
  fi
}

# <artifact contract name>:<exported file name>
for pair in TremorLens:TremorLens VarianceSeriesFactory:VarianceSeriesFactory \
            TremorMarketEngine:TremorMarketEngine VarianceAccumulator:VarianceAccumulator \
            TremorPrograms:TremorPrograms TremorMakerVault:TremorMakerVault \
            TremorSeriesDeployer:TremorSeriesDeployer AquaSwapVMRouter:AquaSwapVMRouter \
            Aqua:Aqua VarianceReceipt:VarianceReceipt ERC20:ERC20 IAggregatorV3:AggregatorV3 \
            RealizedVarianceOracle:RealizedVarianceOracle MockUSDC:MockUSDC \
            TremorPortfolioMarket:TremorPortfolioMarket; do
  contract="${pair%%:*}"; name="${pair##*:}"
  abi=$(forge inspect "$contract" abi --json)
  n=$(printf '%s' "$abi" | python3 -c "import json,sys; a=json.load(sys.stdin); assert isinstance(a,list) and len(a)>0; print(len(a))")
  write_if_changed "$WEB_DIR/$name.json" "$abi"
  write_if_changed "$BE_DIR/$name.json" "$abi"
  echo "  $name.json  ($n entries)"
done
echo "ABIs written to $WEB_DIR and $BE_DIR"
