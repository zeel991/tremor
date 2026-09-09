// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IAqua} from "@1inch/aqua/src/interfaces/IAqua.sol";
import {TakerTraitsLib} from "swap-vm/libs/TakerTraits.sol";

import {SeriesParams, Leg} from "./libs/SeriesParams.sol";
import {RealizedVariance} from "./libs/RealizedVariance.sol";
import {VariancePricing} from "./libs/VariancePricing.sol";
import {VarianceSeriesFactory} from "./VarianceSeriesFactory.sol";
import {TremorMarketEngine} from "./TremorMarketEngine.sol";
import {ITremorController} from "./interfaces/ITremorController.sol";
import {ITremorMakerVault} from "./interfaces/ITremorMakerVault.sol";
import {IVarianceAccumulator} from "./interfaces/IVarianceAccumulator.sol";

/// @notice The read model the UI and the indexer use. Every executable number here comes from the same
///   engine the router calls, so a figure on screen and the fill a taker gets cannot disagree.
///
///   What it deliberately does not do is invent a "fair value". `marketVariance` is this market's own quote,
///   `projectedVariance` is the projection implied by what has actually been checkpointed plus that quote,
///   and `bidPerUnit`/`askPerUnit` are executable prices. None of them is a claim about what variance is
///   worth.
contract TremorLens {
    error BadLensConfiguration();

    enum Status {
        UPCOMING,
        LIVE,
        EXPIRED_UNFINALIZED,
        FINALIZED,
        CLOSED
    }

    /// @notice Enforceable collateral state of a writer's vault. Replaces v1's `Coverage`, which measured a
    ///   wallet the seller could empty at will.
    /// @param allowanceSufficient the vault's Aqua allowance still covers everything it could owe
    struct VaultState {
        address vault;
        address owner;
        uint256 balance;
        uint256 locked;
        uint256 free;
        uint256 aquaAllowance;
        bool allowanceSufficient;
    }

    /// @notice What the market is quoting right now. Grouped so the state struct stays a shape both a
    ///   Rust ABI decoder and a TypeScript client can handle without a 35-element tuple.
    /// @param marketVariance the market's own forward variance after skew decay (WAD) — not a fair value
    /// @param projectedVariance realized-so-far blended with the forward variance, unclamped (WAD)
    /// @param realizedVarianceSoFar annualized variance of the checkpointed samples (WAD)
    /// @param bidPerUnit executable EXIT bid for 1e18 units, quote base units
    /// @param askPerUnit executable ISSUE ask for 1e18 units, quote base units
    struct MarketQuote {
        uint256 marketVariance;
        uint256 projectedVariance;
        uint256 realizedVarianceSoFar;
        uint256 bidVariance;
        uint256 askVariance;
        uint256 bidPerUnit;
        uint256 askPerUnit;
        uint256 maxPayoutPerUnit;
    }

    /// @notice How far the permissionless checkpointing has got.
    struct OracleProgress {
        uint256 samplesStored;
        uint256 samplesAvailable;
        uint256 samplesTotal;
        uint256 processedThrough;
        bool checkpointsCurrent;
    }

    /// @notice Which legs a user can act on, and which Aqua strategies are still shipped.
    struct LegStatus {
        bool issuanceOpen;
        bool exitOpen;
        bool settleOpen;
        bool issueLegActive;
        bool exitLegActive;
        bool settleLegActive;
    }

    struct SeriesState {
        uint256 id;
        address writer;
        address vault;
        address receipt;
        SeriesParams params;
        bytes32 issueOrderHash;
        bytes32 exitOrderHash;
        bytes32 settlementOrderHash;
        Status status;
        LegStatus legs;
        MarketQuote quote;
        uint256 unitsOutstanding;
        uint256 unitsAvailable; // receipt units still shipped on the ISSUE strategy
        uint256 lockedLiability;
        uint256 finalVariance;
        uint256 payoutPerUnit;
        OracleProgress oracle;
        bool fullyCollateralized;
        VaultState vaultState;
    }

    uint256 internal constant WAD = 1e18;
    uint256 internal constant YEAR = 31_536_000;
    uint8 internal constant AQUA_DOCKED = 0xff;

    VarianceSeriesFactory public immutable FACTORY;
    TremorMarketEngine public immutable ENGINE;
    IVarianceAccumulator public immutable ACCUMULATOR;
    address public immutable ROUTER;
    IAqua public immutable AQUA;

    /// @dev Every cross-link is verified here rather than trusted, so a Lens deployed against a mismatched
    ///   factory, engine, accumulator or router cannot come into existence at all.
    constructor(VarianceSeriesFactory factory) {
        require(address(factory).code.length > 0, BadLensConfiguration());
        address engine = factory.ENGINE();
        address accumulator = factory.ACCUMULATOR();
        require(
            engine.code.length > 0 && accumulator.code.length > 0
                && TremorMarketEngine(engine).CONTROLLER() == address(factory)
                && TremorMarketEngine(engine).ACCUMULATOR() == accumulator
                && IVarianceAccumulator(accumulator).CONTROLLER() == address(factory)
                && IVarianceAccumulator(accumulator).FEED() == factory.FEED(),
            BadLensConfiguration()
        );
        FACTORY = factory;
        ENGINE = TremorMarketEngine(engine);
        ACCUMULATOR = IVarianceAccumulator(accumulator);
        ROUTER = factory.ROUTER();
        AQUA = IAqua(factory.AQUA());
    }

    // ------------------------------------------------------------------ series state

    function state(uint256 id) public view returns (SeriesState memory s) {
        (
            address writer,
            address vault,
            address receipt,
            bytes32 issueHash,
            bytes32 exitHash,
            bytes32 settleHash,
            SeriesParams memory p
        ) = FACTORY.series(id);
        ITremorController.SeriesView memory v = FACTORY.seriesView(id);

        s.id = id;
        s.writer = writer;
        s.vault = vault;
        s.receipt = receipt;
        s.params = p;
        s.issueOrderHash = issueHash;
        s.exitOrderHash = exitHash;
        s.settlementOrderHash = settleHash;
        s.unitsOutstanding = v.outstandingUnits;
        s.lockedLiability = v.lockedLiability;
        s.finalVariance = v.finalVariance;
        s.payoutPerUnit = v.payoutPerUnit;

        s.oracle = _oracleProgress(id, p);
        s.quote = _marketQuote(id, p);

        (uint248 aquaIssueReceipt,) = AQUA.rawBalances(vault, ROUTER, issueHash, receipt);
        s.unitsAvailable = aquaIssueReceipt;
        s.legs.issueLegActive = _legActive(vault, issueHash, p.quoteToken);
        s.legs.exitLegActive = _legActive(vault, exitHash, p.quoteToken);
        s.legs.settleLegActive = _legActive(vault, settleHash, p.quoteToken);

        bool closed = FACTORY.isClosed(id);
        if (closed) s.status = Status.CLOSED;
        else if (v.finalized) s.status = Status.FINALIZED;
        else if (block.timestamp >= p.expiry) s.status = Status.EXPIRED_UNFINALIZED;
        else if (block.timestamp < p.start) s.status = Status.UPCOMING;
        else s.status = Status.LIVE;

        s.legs.issuanceOpen = !closed && !v.issuanceStopped && !v.finalized && block.timestamp <= p.saleEnd
            && s.unitsAvailable > 0 && s.legs.issueLegActive;
        s.legs.exitOpen =
            !closed && !v.finalized && block.timestamp < p.expiry && v.outstandingUnits > 0 && s.legs.exitLegActive;
        s.legs.settleOpen = !closed && v.finalized && v.outstandingUnits > 0 && s.legs.settleLegActive;

        s.vaultState = vaultState(vault);
        // Only claim collateralization when all three enforceable conditions hold at once: the vault
        // actually holds what it reserved, Aqua can still move it, and a burn leg is still shipped.
        s.fullyCollateralized = s.vaultState.balance >= s.vaultState.locked && s.vaultState.allowanceSufficient
            && (v.outstandingUnits == 0 || s.legs.exitLegActive || s.legs.settleLegActive);
    }

    function _oracleProgress(uint256 id, SeriesParams memory) internal view returns (OracleProgress memory o) {
        (o.samplesStored, o.samplesAvailable, o.samplesTotal) = ACCUMULATOR.progress(id);
        o.checkpointsCurrent = o.samplesStored >= o.samplesAvailable;
        (,, o.processedThrough) = ACCUMULATOR.realizedSoFar(id);
    }

    function _marketQuote(uint256 id, SeriesParams memory p) internal view returns (MarketQuote memory q) {
        (q.projectedVariance, q.bidVariance, q.askVariance, q.marketVariance, q.realizedVarianceSoFar) =
            ENGINE.market(id);
        q.bidPerUnit = VariancePricing.perUnitPrice(p.unitNotional, q.bidVariance);
        q.askPerUnit = VariancePricing.perUnitPrice(p.unitNotional, q.askVariance);
        q.maxPayoutPerUnit = VariancePricing.maxPayoutPerUnit(p.unitNotional, p.capVariance);
    }

    function states(uint256 from, uint256 to) external view returns (SeriesState[] memory out) {
        uint256 last = FACTORY.seriesCount();
        if (to > last) to = last;
        if (from == 0) from = 1;
        if (from > to) return new SeriesState[](0);
        out = new SeriesState[](to - from + 1);
        for (uint256 i = from; i <= to; i++) {
            out[i - from] = state(i);
        }
    }

    // ------------------------------------------------------------------ vault state

    function vaultState(address vault) public view returns (VaultState memory vs) {
        vs.vault = vault;
        if (vault == address(0) || vault.code.length == 0) return vs;
        ITremorMakerVault v = ITremorMakerVault(vault);
        vs.owner = v.OWNER();
        vs.balance = v.quoteBalance();
        vs.locked = v.lockedQuote();
        vs.free = v.freeQuote();
        vs.aquaAllowance = v.aquaAllowance();
        vs.allowanceSufficient = vs.aquaAllowance >= vs.locked;
    }

    /// @notice The vault a writer has, or the address the one they create will have.
    function writerVault(address writer) external view returns (address vault, bool exists, VaultState memory vs) {
        vault = FACTORY.vaultOf(writer);
        exists = vault != address(0);
        if (!exists) return (FACTORY.predictVault(writer), false, vs);
        vs = vaultState(vault);
    }

    // ------------------------------------------------------------------ quotes (delegated to the engine)

    function quoteIssueExactIn(uint256 id, uint256 quoteIn) external view returns (uint256 units, uint256 premium) {
        return ENGINE.quoteIssueExactIn(id, quoteIn);
    }

    function quoteIssueExactOut(uint256 id, uint256 units)
        external
        view
        returns (uint256 filledUnits, uint256 premium)
    {
        return ENGINE.quoteIssueExactOut(id, units);
    }

    function quoteExitExactIn(uint256 id, uint256 units) external view returns (uint256 filledUnits, uint256 quoteOut) {
        return ENGINE.quoteExitExactIn(id, units);
    }

    function quoteSettleExactIn(uint256 id, uint256 units)
        external
        view
        returns (uint256 filledUnits, uint256 quoteOut)
    {
        return ENGINE.quoteSettleExactIn(id, units);
    }

    // ------------------------------------------------------------------ variance helpers

    function realizedVariance(address feed, uint40 start, uint40 end, uint32 interval)
        external
        view
        returns (uint256 rv, uint256 samples)
    {
        return RealizedVariance.compute(feed, start, end, interval);
    }

    function samplePrices(address feed, uint40 start, uint40 end, uint32 interval)
        external
        view
        returns (uint256[] memory prices, uint80[] memory roundIds)
    {
        return RealizedVariance.samples(feed, start, end, interval);
    }

    function priceAt(address feed, uint256 t) external view returns (uint256 answer, uint80 roundId) {
        return RealizedVariance.priceAt(feed, t);
    }

    /// @notice Volatility as a percentage with 18 decimals: `sqrt(variance) * 100`.
    function volatilityPct(uint256 variance) external pure returns (uint256) {
        return Math.sqrt(variance * WAD) * 100;
    }

    // ------------------------------------------------------------------ taker helpers

    /// @notice TakerTraits bytes for a plain EOA: the router pulls tokenIn via `transferFrom` (so the taker
    ///   approves the ROUTER, not Aqua) and pushes it to Aqua itself. `threshold` is min-out for exact-in
    ///   and max-in for exact-out; 0 means none.
    ///
    ///   `allowPartialFill` is what makes the engine's clamps reachable — receipt inventory, the vault's
    ///   free collateral, the cap, outstanding units, released liability. With it off, TakerTraits requires
    ///   `takerAmount == amountIn` and any clamped fill reverts. With it on, the threshold becomes a limit
    ///   *rate*: TakerTraits pro-rates it by the fraction actually filled, so pass the threshold for the
    ///   full taker amount.
    function buildTakerData(
        address taker,
        bool isExactIn,
        bool isAToB,
        uint256 thresholdAmount,
        uint40 deadline,
        bool allowPartialFill
    ) public pure returns (bytes memory) {
        bytes memory threshold = thresholdAmount == 0 ? bytes("") : abi.encodePacked(thresholdAmount);
        return TakerTraitsLib.build(
            TakerTraitsLib.Args({
                taker: taker,
                isExactIn: isExactIn,
                shouldUnwrapWeth: false,
                isStrictThresholdAmount: false,
                isFirstTransferFromTaker: false,
                useTransferFromAndAquaPush: true,
                isAToB: isAToB,
                allowPartialFill: allowPartialFill,
                threshold: threshold,
                to: address(0),
                deadline: deadline,
                hasPreTransferInCallback: false,
                hasPreTransferOutCallback: false,
                preTransferInHookData: "",
                postTransferInHookData: "",
                preTransferOutHookData: "",
                postTransferOutHookData: "",
                preTransferInCallbackData: "",
                preTransferOutCallbackData: "",
                instructionsArgs: "",
                signature: ""
            })
        );
    }

    /// @notice `isAToB` for the taker of a leg, relative to the order's sorted tokenA/tokenB.
    function legDirection(uint256 id, Leg leg) external view returns (bool isAToB) {
        (,, address receipt,,,, SeriesParams memory p) = FACTORY.series(id);
        return leg == Leg.ISSUE ? p.quoteToken < receipt : receipt < p.quoteToken;
    }

    /// @notice Units (18 dec) of series `id` whose maximum payout matches a gross LVR sizing estimate
    ///   `E[LVR] = V * sigma^2 * T / 8` for a pool worth `poolValueQuote` over `horizonSeconds`.
    /// @dev A sizing aid, not a replicating hedge: realized variance of a Chainlink sample path is not the
    ///   quadratic variation an AMM actually pays, and the residual basis is not bounded here.
    function lvrHedgeUnits(uint256 id, uint256 poolValueQuote, uint40 horizonSeconds) external view returns (uint256) {
        (,,,,,, SeriesParams memory p) = FACTORY.series(id);
        return Math.mulDiv(poolValueQuote * uint256(horizonSeconds), WAD, 8 * YEAR * uint256(p.unitNotional));
    }

    // ------------------------------------------------------------------ internals

    function _legActive(address vault, bytes32 orderHash, address token) internal view returns (bool) {
        (, uint8 tokensCount) = AQUA.rawBalances(vault, ROUTER, orderHash, token);
        return tokensCount > 0 && tokensCount != AQUA_DOCKED;
    }
}
