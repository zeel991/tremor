// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Script, console2} from "forge-std/Script.sol";

import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {AquaSwapVMRouter} from "swap-vm/routers/AquaSwapVMRouter.sol";

import {SeriesParams, Leg} from "../src/libs/SeriesParams.sol";
import {VariancePricing} from "../src/libs/VariancePricing.sol";
import {VarianceSeriesFactory} from "../src/VarianceSeriesFactory.sol";
import {VarianceAccumulator} from "../src/VarianceAccumulator.sol";
import {TremorPrograms} from "../src/TremorPrograms.sol";
import {TremorLens} from "../src/TremorLens.sol";
import {TremorMakerVault} from "../src/TremorMakerVault.sol";
import {VarianceReceipt} from "../src/tokens/VarianceReceipt.sol";
import {RealizedVarianceOracle} from "../src/RealizedVarianceOracle.sol";

/// @notice Fork demo stages, run by `script/demo.sh` against `anvil --fork-url base --auto-impersonate`.
///
///   Each stage is a separate broadcast so the demo can be narrated live, and each one asserts what it
///   claims rather than printing it:
///
///     stageA  writer's protected vault: create, deposit, create a forward series, ship all three
///             strategies, and prove no collateral is reserved before a sale
///     stageB  buyer1 buys receipts; exactly the sold units' liability becomes locked
///     stageC  the three writer attacks — withdraw reserved collateral, revoke the Aqua allowance, dock a
///             burn leg — each of which must fail on chain, not in a UI
///     stageD  buyer1 exits part of the position at the executable bid; receipts burn, liability releases
///     stageE  a back-dated series: walk real Chainlink history in bounded permissionless checkpoints,
///             finalize, redeem, and close
///     stageF  warm the trailing-variance cache the LVR page reads
contract DemoFlow is Script {
    uint256 constant PK_WRITER = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // anvil 0
    uint256 constant PK_BUYER1 = 0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d; // anvil 1
    uint256 constant PK_BUYER2 = 0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a; // anvil 2

    uint256 constant WAD = 1e18;

    struct Env {
        VarianceSeriesFactory factory;
        VarianceAccumulator accumulator;
        TremorPrograms programs;
        TremorLens lens;
        AquaSwapVMRouter router;
        IAqua aqua;
        IERC20 usdc;
        address feed;
        RealizedVarianceOracle oracle;
    }

    function _env() internal view returns (Env memory e) {
        string memory json = vm.readFile(string.concat("./deployments/", vm.toString(block.chainid), ".json"));
        require(vm.parseJsonUint(json, ".schemaVersion") == 3, "manifest is not schema v3");
        e.factory = VarianceSeriesFactory(vm.parseJsonAddress(json, ".seriesFactory"));
        e.accumulator = VarianceAccumulator(vm.parseJsonAddress(json, ".accumulator"));
        e.programs = TremorPrograms(vm.parseJsonAddress(json, ".programs"));
        e.lens = TremorLens(vm.parseJsonAddress(json, ".lens"));
        e.router = AquaSwapVMRouter(payable(vm.parseJsonAddress(json, ".router")));
        e.aqua = IAqua(vm.parseJsonAddress(json, ".aqua"));
        e.usdc = IERC20(vm.parseJsonAddress(json, ".usdc"));
        e.feed = vm.parseJsonAddress(json, ".feed");
        e.oracle = RealizedVarianceOracle(vm.parseJsonAddress(json, ".oracle"));
    }

    // ------------------------------------------------------------------ stage A: the protected vault

    function stageA() external {
        Env memory e = _env();
        address writer = vm.addr(PK_WRITER);

        SeriesParams memory p = _forwardParams(e);
        uint256 liability = VariancePricing.maxLiability(p.maxUnits, p.unitNotional, p.capVariance);

        vm.startBroadcast(PK_WRITER);
        address vault = e.factory.createVault();
        e.usdc.approve(vault, liability);
        TremorMakerVault(vault).deposit(liability);
        (uint256 id, address receipt) = e.factory.createSeries(vault, p);
        vm.stopBroadcast();

        TremorMakerVault v = TremorMakerVault(vault);
        require(vault == e.factory.predictVault(writer), "vault is not at its deterministic address");
        require(v.OWNER() == writer, "vault owner");
        require(v.aquaAllowance() == type(uint256).max, "vault must grant Aqua an unrevokable allowance");
        require(v.quoteBalance() == liability, "deposit did not land");
        require(v.lockedQuote() == 0, "no collateral may be reserved before a sale");
        require(v.freeQuote() == liability, "all collateral is still withdrawable");
        require(VarianceReceipt(receipt).balanceOf(vault) == p.maxUnits, "inventory belongs to the vault");
        require(VarianceReceipt(receipt).balanceOf(writer) == 0, "the writer personally holds no inventory");

        TremorLens.SeriesState memory s = e.lens.state(id);
        require(
            s.legs.issueLegActive && s.legs.exitLegActive && s.legs.settleLegActive,
            "all three strategies must be shipped"
        );
        require(s.legs.issuanceOpen, "issuance should be open");
        require(s.quote.marketVariance == p.anchorVariance, "a fresh market sits at its anchor");

        (,,, bytes32 issueHash, bytes32 exitHash, bytes32 settleHash,) = e.factory.series(id);
        (uint248 issueInv,) = e.aqua.rawBalances(vault, address(e.router), issueHash, receipt);
        (uint248 exitQuote,) = e.aqua.rawBalances(vault, address(e.router), exitHash, address(e.usdc));
        (uint248 settleQuote,) = e.aqua.rawBalances(vault, address(e.router), settleHash, address(e.usdc));
        require(issueInv == p.maxUnits, "ISSUE ships the inventory");
        require(exitQuote == liability && settleQuote == liability, "both burn legs ship the maximum liability");

        console2.log("STAGE A  series", id);
        console2.log("  vault            ", vault);
        console2.log("  receipt          ", receipt);
        console2.log("  deposited (6dp)  ", liability);
        console2.log("  locked (6dp)     ", v.lockedQuote());
        console2.log("  market vol pct   ", e.lens.volatilityPct(s.quote.marketVariance) / 1e16);
        console2.log("  ask per unit     ", s.quote.askPerUnit);
        console2.log("  bid per unit     ", s.quote.bidPerUnit);
        console2.log("  max payout/unit  ", s.quote.maxPayoutPerUnit);
    }

    // ------------------------------------------------------------------ stage B: issuance reserves sold units

    function stageB() external {
        Env memory e = _env();
        uint256 id = e.factory.seriesCount();
        (, address vault, address receipt,,,, SeriesParams memory p) = e.factory.series(id);
        TremorMakerVault v = TremorMakerVault(vault);

        uint256 lockedBefore = v.lockedQuote();
        uint256 vaultBefore = e.usdc.balanceOf(vault);
        uint256 paid1 = _buy(e, PK_BUYER1, id, 20e18);
        uint256 lockedAfter = v.lockedQuote();

        require(VarianceReceipt(receipt).balanceOf(vm.addr(PK_BUYER1)) == 20e18, "buyer1 holds 20 units");
        require(e.usdc.balanceOf(vault) == vaultBefore + paid1, "the premium is the vault's, free and clear");
        require(
            lockedAfter - lockedBefore == VariancePricing.maxLiability(20e18, p.unitNotional, p.capVariance),
            "exactly the sold units' capped liability became locked"
        );
        require(v.quoteBalance() >= v.lockedQuote(), "vault must stay solvent");

        // A second buyer pays a higher ask: selling inventory moves the market.
        uint256 askBefore = e.lens.state(id).quote.askPerUnit;
        uint256 paid2 = _buy(e, PK_BUYER2, id, 10e18);
        require(e.lens.state(id).quote.askPerUnit > askBefore, "inventory impact must raise the ask");
        require(e.factory.seriesView(id).outstandingUnits == 30e18, "30 units outstanding");

        console2.log("STAGE B  series", id);
        console2.log("  buyer1 paid (6dp)", paid1);
        console2.log("  buyer2 paid (6dp)", paid2);
        console2.log("  ask before/after ", askBefore, e.lens.state(id).quote.askPerUnit);
        console2.log("  locked (6dp)     ", v.lockedQuote());
        console2.log("  free (6dp)       ", v.freeQuote());
    }

    // ------------------------------------------------------------------ stage C: the writer attacks and fails

    /// @notice The rug paths Tremor v1 could not close, each attempted from the writer's own address
    ///   against the live forked state.
    ///
    ///   This stage is run WITHOUT `--broadcast`, on purpose: a transaction that reverts cannot be
    ///   broadcast at all, which is precisely the finding. Every attempt below is asserted to revert with
    ///   its specific error rather than merely to fail, so this is evidence about the contracts and not
    ///   about a disabled button. `stageCLegitimate` then broadcasts the two things a writer really can
    ///   do, and shows that neither of them reaches a holder's collateral.
    function stageCAttacks() external {
        Env memory e = _env();
        uint256 id = e.factory.seriesCount();
        (address writer, address vault, address receipt,,, bytes32 settleHash,) = e.factory.series(id);
        TremorMakerVault v = TremorMakerVault(vault);

        uint256 locked = v.lockedQuote();
        uint256 free = v.freeQuote();
        require(locked > 0, "stage C needs an outstanding position to protect");

        // 1. Take reserved collateral.
        _mustRevert(
            writer,
            vault,
            abi.encodeWithSelector(TremorMakerVault.withdrawFree.selector, free + 1, writer),
            TremorMakerVault.ExceedsFree.selector,
            "withdraw one base unit more than is free"
        );

        // 2. Dock the settlement strategy through the vault.
        address[] memory tokens = new address[](2);
        (tokens[0], tokens[1]) = address(e.usdc) < receipt ? (address(e.usdc), receipt) : (receipt, address(e.usdc));
        _mustRevert(
            writer,
            vault,
            abi.encodeWithSelector(TremorMakerVault.dockStrategy.selector, settleHash, tokens),
            TremorMakerVault.NotController.selector,
            "dock the settlement strategy through the vault"
        );

        // 3. Dock it directly in Aqua. Aqua keys strategies by msg.sender, so the writer's own strategy
        //    space is empty and there is nothing there for them to dock.
        _mustRevert(
            writer,
            address(e.aqua),
            abi.encodeWithSelector(IAqua.dock.selector, address(e.router), settleHash, tokens),
            IAqua.DockingShouldCloseAllTokens.selector,
            "dock the settlement strategy directly in Aqua"
        );

        // 4. Make the vault do something else entirely.
        _mustFail(
            writer, vault, abi.encodeWithSignature("execute(address,bytes)", address(e.usdc), ""), "arbitrary call"
        );
        _mustFail(
            writer,
            vault,
            abi.encodeWithSignature("rescueFunds(address,uint256)", receipt, uint256(1)),
            "rescue the receipt inventory"
        );
        _mustFail(
            writer,
            vault,
            abi.encodeWithSignature("transferOwnership(address)", vm.addr(PK_BUYER2)),
            "hand off ownership"
        );

        TremorLens.SeriesState memory s = e.lens.state(id);
        require(s.legs.exitLegActive && s.legs.settleLegActive, "both burn legs must still be live after the attacks");
        require(v.lockedQuote() == locked, "the reservation must be untouched");
        require(v.quoteBalance() >= v.lockedQuote(), "vault must stay solvent");

        console2.log("STAGE C  every writer attack was blocked on series", id);
        console2.log("  locked still (6dp) ", v.lockedQuote());
        console2.log("  vault balance (6dp)", v.quoteBalance());
        console2.log("  aqua allowance     ", v.aquaAllowance());
        console2.log("  exit leg active    ", s.legs.exitLegActive);
        console2.log("  settle leg active  ", s.legs.settleLegActive);
    }

    /// @notice What a writer legitimately can do, broadcast for real: revoke their own USDC approval to
    ///   Aqua, which does not touch the vault's, and withdraw every unreserved dollar, after which the
    ///   reservation is all that is left in the vault.
    function stageCLegitimate() external {
        Env memory e = _env();
        uint256 id = e.factory.seriesCount();
        (address writer, address vault,,,,,) = e.factory.series(id);
        TremorMakerVault v = TremorMakerVault(vault);
        uint256 locked = v.lockedQuote();
        uint256 free = v.freeQuote();

        vm.startBroadcast(PK_WRITER);
        e.usdc.approve(address(e.aqua), 0);
        v.withdrawFree(free, writer);
        vm.stopBroadcast();

        require(v.aquaAllowance() == type(uint256).max, "ATTACK SUCCEEDED: the Aqua allowance was reduced");
        require(v.freeQuote() == 0, "the writer should now hold every free dollar");
        require(v.quoteBalance() == locked, "exactly the reservation is left behind");
        require(v.lockedQuote() == locked, "the reservation must be untouched");

        console2.log("STAGE C+ writer took every unreserved dollar of series", id);
        console2.log("  premiums withdrawn (6dp)", free);
        console2.log("  vault balance (6dp)     ", v.quoteBalance());
        console2.log("  locked (6dp)            ", v.lockedQuote());
        console2.log("  free (6dp)              ", v.freeQuote());
    }

    /// @dev Simulates `data` from `from` against the live forked state and requires it to revert with
    ///   `expectedSelector`. Not broadcast: a reverting transaction cannot be, which is the whole finding.
    function _mustRevert(address from, address target, bytes memory data, bytes4 expectedSelector, string memory what)
        internal
    {
        vm.prank(from);
        (bool ok, bytes memory ret) = target.call(data);
        require(!ok, string.concat("ATTACK SUCCEEDED: ", what));
        require(ret.length >= 4, string.concat("attack failed without a reason: ", what));
        bytes4 selector = bytes4(ret);
        require(selector == expectedSelector, string.concat("attack failed for the wrong reason: ", what));
        console2.log("  BLOCKED:", what);
    }

    /// @dev Same as `_mustRevert` for calls the vault has no function for at all, where there is no
    ///   revert reason to match — the point being that the surface does not exist.
    function _mustFail(address from, address target, bytes memory data, string memory what) internal {
        vm.prank(from);
        (bool ok,) = target.call(data);
        require(!ok, string.concat("ATTACK SUCCEEDED: ", what));
        console2.log("  NO SUCH SURFACE:", what);
    }

    // ------------------------------------------------------------------ stage D: the executable exit

    function stageD() external {
        Env memory e = _env();
        uint256 id = e.factory.seriesCount();
        (, address vault, address receipt,,,, SeriesParams memory p) = e.factory.series(id);
        address buyer = vm.addr(PK_BUYER1);
        TremorMakerVault v = TremorMakerVault(vault);

        _checkpointAll(e, id, 32);

        (uint256 quotedUnits, uint256 quotedOut) = e.lens.quoteExitExactIn(id, 8e18);
        require(quotedUnits == 8e18, "the bid should be good for the whole 8 units");
        require(quotedOut > 0, "an exit bid must be executable, not indicative");

        uint256 supplyBefore = VarianceReceipt(receipt).totalSupply();
        uint256 lockedBefore = v.lockedQuote();
        uint256 buyerBefore = e.usdc.balanceOf(buyer);

        ISwapVM.Order memory o = e.programs.order(id, Leg.EXIT);
        bytes memory data = e.lens.buildTakerData(buyer, true, e.lens.legDirection(id, Leg.EXIT), 0, 0, false);
        vm.startBroadcast(PK_BUYER1);
        IERC20(receipt).approve(address(e.router), type(uint256).max);
        (uint256 unitsIn, uint256 quoteOut,) = e.router.swap(o, 8e18, data);
        vm.stopBroadcast();

        require(unitsIn == 8e18, "exit units");
        require(quoteOut == quotedOut, "the swap must pay exactly the quoted bid");
        require(e.usdc.balanceOf(buyer) == buyerBefore + quoteOut, "USDC reached the holder");
        require(VarianceReceipt(receipt).totalSupply() == supplyBefore - 8e18, "exited receipts must be burned");
        uint256 released = lockedBefore - v.lockedQuote();
        require(quoteOut <= released, "an exit cannot pay more than the liability it releases");
        require(v.quoteBalance() >= v.lockedQuote(), "vault must stay solvent");
        require(
            v.lockedQuote()
                == VariancePricing.maxLiability(
                    e.factory.seriesView(id).outstandingUnits, p.unitNotional, p.capVariance
                ),
            "liability must be repriced from the aggregate position"
        );

        console2.log("STAGE D  series", id);
        console2.log("  units exited     ", unitsIn);
        console2.log("  proceeds (6dp)   ", quoteOut);
        console2.log("  liability freed  ", released);
        console2.log("  receipts burned  ", supplyBefore - VarianceReceipt(receipt).totalSupply());
        console2.log("  locked now (6dp) ", v.lockedQuote());
    }

    // ------------------------------------------------------------------ stage E: the oracle and settlement

    function stageE() external {
        Env memory e = _env();
        address writer = vm.addr(PK_WRITER);
        address buyer = vm.addr(PK_BUYER1);

        // A back-dated window so real Chainlink history can be walked and finalized inside the demo.
        uint40 expiry = uint40(block.timestamp - 1 hours);
        SeriesParams memory p = _forwardParams(e);
        p.expiry = expiry;
        p.start = uint40(expiry - 5 days);
        p.saleEnd = uint40(block.timestamp + 1 hours);
        p.maxUnits = 50e18;
        uint256 liability = VariancePricing.maxLiability(p.maxUnits, p.unitNotional, p.capVariance);

        vm.startBroadcast(PK_WRITER);
        address vault = e.factory.createVault(); // idempotent: the writer already has one
        e.usdc.approve(vault, liability);
        TremorMakerVault(vault).deposit(liability);
        (uint256 id, address receipt) = e.factory.createBackdatedDemoSeries(vault, p);
        vm.stopBroadcast();

        // Anyone can checkpoint. The demo uses buyer2, who has no role in this series at all.
        uint256 calls = _checkpointAll(e, id, 8);
        VarianceAccumulator.Accumulator memory acc = e.accumulator.accumulator(id);
        require(acc.processedThrough == p.expiry, "the whole window must be checkpointed");
        require(acc.lastRoundId > 0, "the samples must come from real Chainlink rounds");

        uint256 paid = _buy(e, PK_BUYER1, id, 10e18);
        TremorMakerVault v = TremorMakerVault(vault);
        // Series-scoped, because this writer's vault also backs the forward series from stage A.
        uint256 cappedLock = e.factory.seriesView(id).lockedLiability;

        vm.startBroadcast(PK_BUYER2); // an unprivileged account finalizes
        uint256 finalVariance = e.accumulator.finalize(id);
        vm.stopBroadcast();

        (uint256 oneShot,) = e.lens.realizedVariance(p.feed, p.start, p.expiry, p.sampleInterval);
        require(finalVariance == oneShot, "bounded checkpoints must equal a direct computation");
        uint256 ppu = e.factory.seriesView(id).payoutPerUnit;
        require(
            e.factory.seriesView(id).lockedLiability <= cappedLock, "the cap surplus must be released at finalization"
        );

        (uint256 qUnits, uint256 qOut) = e.lens.quoteSettleExactIn(id, 10e18);
        require(qUnits == 10e18, "the whole position should be redeemable");
        uint256 buyerBefore = e.usdc.balanceOf(buyer);
        uint256 supplyBefore = VarianceReceipt(receipt).totalSupply();

        ISwapVM.Order memory o = e.programs.order(id, Leg.SETTLE);
        bytes memory data = e.lens.buildTakerData(buyer, true, e.lens.legDirection(id, Leg.SETTLE), 0, 0, false);
        vm.startBroadcast(PK_BUYER1);
        IERC20(receipt).approve(address(e.router), type(uint256).max);
        (uint256 unitsIn, uint256 quoteOut,) = e.router.swap(o, 10e18, data);
        vm.stopBroadcast();

        require(unitsIn == 10e18 && quoteOut == qOut, "the swap must pay exactly the quoted redemption");
        require(quoteOut == 10e18 * ppu / WAD, "redemption is units times the fixed payout");
        require(e.usdc.balanceOf(buyer) == buyerBefore + quoteOut, "USDC reached the holder");
        require(VarianceReceipt(receipt).totalSupply() == supplyBefore - 10e18, "redeemed receipts must burn");
        require(e.factory.seriesView(id).outstandingUnits == 0, "no claims left");
        require(e.factory.seriesView(id).lockedLiability == 0, "every matching liability must be released");
        require(v.quoteBalance() >= v.lockedQuote(), "vault must stay solvent");

        vm.startBroadcast(PK_WRITER);
        e.factory.stopIssuance(id);
        vm.stopBroadcast();
        vm.startBroadcast(PK_BUYER2); // closing is permissionless too
        e.factory.closeSeries(id);
        vm.stopBroadcast();
        require(VarianceReceipt(receipt).totalSupply() == 0, "unsold inventory must burn at close");

        console2.log("STAGE E  series", id);
        console2.log("  bounded checkpoint calls", calls);
        console2.log("  last chainlink round    ", acc.lastRoundId);
        console2.log("  chainlink phase         ", acc.lastRoundId >> 64);
        console2.log("  final variance (wad)    ", finalVariance);
        console2.log("  annualized vol pct      ", e.lens.volatilityPct(finalVariance) / 1e16);
        console2.log("  payout per unit (6dp)   ", ppu);
        console2.log("  premium collected (6dp) ", paid);
        console2.log("  redeemed (6dp)          ", quoteOut);
        console2.log("  writer net (6dp)        ", paid > quoteOut ? paid - quoteOut : 0);
        console2.log("  writer address          ", writer);
    }

    // ------------------------------------------------------------------ stage F: trailing variance for LVR

    function stageF() external {
        Env memory e = _env();
        vm.startBroadcast(PK_WRITER);
        uint256 rv1d = e.oracle.poke(e.feed, 1 days, 3600);
        uint256 rv7d = e.oracle.poke(e.feed, 7 days, 3600);
        vm.stopBroadcast();
        require(rv1d > 0 && rv7d > 0, "trailing variance should be non-zero on real ETH/USD history");

        console2.log("STAGE F  trailing realized variance from real Chainlink history");
        console2.log("  1d variance (wad)", rv1d);
        console2.log("  1d vol pct       ", e.lens.volatilityPct(rv1d) / 1e16);
        console2.log("  7d variance (wad)", rv7d);
        console2.log("  7d vol pct       ", e.lens.volatilityPct(rv7d) / 1e16);
    }

    // ------------------------------------------------------------------ helpers

    function _forwardParams(Env memory e) internal view returns (SeriesParams memory p) {
        p = SeriesParams({
            feed: e.feed,
            quoteToken: address(e.usdc),
            start: uint40(block.timestamp),
            expiry: uint40(block.timestamp + 7 days),
            saleEnd: uint40(block.timestamp + 7 days),
            sampleInterval: 7200,
            unitNotional: 100e6,
            capVariance: 1e18,
            anchorVariance: 0.2e18,
            impactPerUnit: 0.01e18,
            halfLife: 6 hours,
            halfSpreadBps: 200,
            maxUnits: 100e18
        });
    }

    function _buy(Env memory e, uint256 pk, uint256 id, uint256 units) internal returns (uint256 paid) {
        address buyer = vm.addr(pk);
        (uint256 filled, uint256 quoted) = e.lens.quoteIssueExactOut(id, units);
        require(filled == units, "the market cannot fill the demo size");
        ISwapVM.Order memory o = e.programs.order(id, Leg.ISSUE);
        bytes memory data = e.lens.buildTakerData(buyer, false, e.lens.legDirection(id, Leg.ISSUE), quoted, 0, false);
        vm.startBroadcast(pk);
        e.usdc.approve(address(e.router), type(uint256).max);
        (paid,,) = e.router.swap(o, units, data);
        vm.stopBroadcast();
        require(paid == quoted, "the swap premium must equal the Lens quote");
    }

    /// @dev Walk the accumulator to the head of the window in bounded calls, from an account with no role
    ///   in the series, which is the point: checkpointing is permissionless.
    function _checkpointAll(Env memory e, uint256 id, uint16 perCall) internal returns (uint256 calls) {
        while (true) {
            (uint256 stored, uint256 available,) = e.accumulator.progress(id);
            if (stored >= available) return calls;
            vm.startBroadcast(PK_BUYER2);
            e.accumulator.checkpoint(id, perCall);
            vm.stopBroadcast();
            calls += 1;
            require(calls < 200, "checkpointing did not converge");
        }
    }
}
