#!/usr/bin/env python3
"""Compare every deployed Base Sepolia contract's runtime bytecode against the locally built artifact.

Reproducible-build provenance for the Base Sepolia deployment. Constructor immutables are written into
runtime code, so an exact hash match is impossible; this compares byte-for-byte and reports whether any
differing byte falls OUTSIDE the immutable slots that solc itself recorded in `immutableReferences`.

Usage (from contracts/):
    forge build
    python3 ../docs/submission/evidence/verify-deployed-bytecode.py

Exit code 0 only if every contract is identical outside its immutable slots.
"""

import json
import subprocess
import sys

RPC = "https://sepolia.base.org"

# contract name -> (forge artifact path relative to contracts/, deployed address on 84532)
#
# AquaSwapVMRouter is the official 1inch router source vendored at contracts/lib/swap-vm; including it
# here is what substantiates the "unmodified official router" claim at the bytecode level. The vendored
# submodule has no .git directory, so its upstream commit cannot be recovered — which is why the manifest
# records routerSourceCommit as "unknown" while still pinning routerBytecodeHash.
TARGETS = {
    "AquaSwapVMRouter": (
        "out/AquaSwapVMRouter.sol/AquaSwapVMRouter.json",
        "0xb8dcED3Cf6266Dd8fEc05849fce3734B79A7e722",
    ),
    "TremorPortfolioMarket": (
        "out/TremorPortfolioMarket.sol/TremorPortfolioMarket.json",
        "0x72798A6697Cb648847ec0E5ba0bc6491B2901ddb",
    ),
    "VarianceSeriesFactory": (
        "out/VarianceSeriesFactory.sol/VarianceSeriesFactory.json",
        "0xC86Cf4AD22ABD7169458cCDc58c51e71f23586f2",
    ),
    "TremorMarketEngine": (
        "out/TremorMarketEngine.sol/TremorMarketEngine.json",
        "0x44a76D0Df659708a5b8170c0eE1C600C8bc3Eba0",
    ),
    "TremorLens": (
        "out/TremorLens.sol/TremorLens.json",
        "0x016CEde278FFB5B2B79E9d7afe11E4d17Bb9B059",
    ),
    "TremorPrograms": (
        "out/TremorPrograms.sol/TremorPrograms.json",
        "0x169b52DFa0aFcbCB83A442EfBDBB21cd35209bD0",
    ),
    "VarianceAccumulator": (
        "out/VarianceAccumulator.sol/VarianceAccumulator.json",
        "0xea5A9Cfb462509f51420E10f5732891481fE634F",
    ),
    "TremorSeriesDeployer": (
        "out/TremorSeriesDeployer.sol/TremorSeriesDeployer.json",
        "0x1E9117E447e4C2C14B8be4eE59877d66bE8B6893",
    ),
    "TremorMakerVault": (
        "out/TremorMakerVault.sol/TremorMakerVault.json",
        "0x9C9341d0E752a97BD1c7c47FB1579866daBCc47C",
    ),
    "RealizedVarianceOracle": (
        "out/RealizedVarianceOracle.sol/RealizedVarianceOracle.json",
        "0x7c40518dA5C3dEa9E5F74d12093bbd53d9FC1124",
    ),
}


def fetch_code(addr: str) -> bytes:
    out = subprocess.run(
        ["cast", "code", addr, "-r", RPC], capture_output=True, text=True, check=True
    ).stdout.strip()
    return bytes.fromhex(out[2:])


def main() -> int:
    failures = 0
    print(f"{'contract':<24} {'local B':>8} {'chain B':>8} {'diffs':>7} {'imm refs':>9}  verdict")
    for name, (artifact, addr) in TARGETS.items():
        with open(artifact) as fh:
            art = json.load(fh)
        local = bytes.fromhex(art["deployedBytecode"]["object"][2:])
        imm_refs = art["deployedBytecode"].get("immutableReferences", {})
        n_imm = sum(len(v) for v in imm_refs.values())

        chain = fetch_code(addr)
        if len(local) != len(chain):
            print(f"{name:<24} {len(local):>8} {len(chain):>8} {'-':>7} {n_imm:>9}  LENGTH MISMATCH")
            failures += 1
            continue

        covered = set()
        for refs in imm_refs.values():
            for ref in refs:
                start, length = int(ref["start"]), int(ref["length"])
                covered.update(range(start, start + length))

        diff = [i for i in range(len(local)) if local[i] != chain[i]]
        outside = [i for i in diff if i not in covered]
        if outside:
            print(
                f"{name:<24} {len(local):>8} {len(chain):>8} {len(diff):>7} {n_imm:>9}  "
                f"{len(outside)} BYTES DIFFER OUTSIDE IMMUTABLES"
            )
            failures += 1
        else:
            print(
                f"{name:<24} {len(local):>8} {len(chain):>8} {len(diff):>7} {n_imm:>9}  "
                f"identical outside immutables"
            )
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
