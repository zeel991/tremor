#!/usr/bin/env bash
# Copies the compiled TremorLens ABI into backend/abi/TremorLens.json so that build.rs generates the
# Lens bindings from the real artifact (cfg(lens_abi_json)) instead of the hand-written §2.2 sol! block.
#   tools/refresh_abi.sh [path/to/TremorLens.json]      (default: ../contracts/out/TremorLens.sol/TremorLens.json)
# Then: cargo build   (set TREMOR_LENS_FROM_SOL=1 to force the sol! definitions again)
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
SRC="${1:-$HERE/../contracts/out/TremorLens.sol/TremorLens.json}"
mkdir -p "$HERE/abi"
python3 - "$SRC" "$HERE/abi/TremorLens.json" <<'PY'
import json, sys
art = json.load(open(sys.argv[1]))
abi = art["abi"] if isinstance(art, dict) and "abi" in art else art
json.dump(abi, open(sys.argv[2], "w"), indent=2)
print(f"wrote {sys.argv[2]} ({len(abi)} ABI items) from {sys.argv[1]}")
PY
