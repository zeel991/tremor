// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {SeriesParams, Leg} from "./libs/SeriesParams.sol";
import {TremorOrderBuilder} from "./libs/TremorOrderBuilder.sol";
import {VariancePricing} from "./libs/VariancePricing.sol";
import {IAggregatorV3} from "./interfaces/IAggregatorV3.sol";
import {ITremorMakerVault} from "./interfaces/ITremorMakerVault.sol";
import {ITremorController} from "./interfaces/ITremorController.sol";
import {IVarianceAccumulator} from "./interfaces/IVarianceAccumulator.sol";
import {VarianceAccumulator} from "./VarianceAccumulator.sol";
import {TremorMarketEngine} from "./TremorMarketEngine.sol";
import {TremorSeriesDeployer} from "./TremorSeriesDeployer.sol";
import {VarianceReceipt} from "./tokens/VarianceReceipt.sol";

/// @notice Registry, controller and single source of truth for Tremor markets.
///
///   It deploys the writer vaults, creates series, ships all three Aqua strategies, owns the per-series
///   liability ledger, and is the only contract the engine, the accumulator and the receipts are allowed to
///   report to. Its constructor also deploys its own children — the accumulator, the engine and the
///   creation-code deployer — so each of them receives this contract's final address as an immutable and
///   there is no initializer, no predicted-address wiring and no window in which the cross-links are wrong.
///
///   It is immutable. There is no owner, no upgrade path, no pause and no discretionary override. The only
///   privileged caller anywhere in the system is a series' own writer, and the only two things a writer can
///   do are stop future issuance and withdraw collateral that is not reserved.
///
///   What replaced v1: the seller-wide `aggregateReserved` ledger and the point-in-time wallet/allowance
///   coverage check are gone. Reservations are no longer conservative full-cap guesses checked against a
///   wallet the seller still controls; they are exact, per-series, computed from the aggregate outstanding
///   position, and held inside a vault the writer cannot drain.
contract VarianceSeriesFactory is ITremorController {
    // ------------------------------------------------------------------ errors

    error BadFeed();
    error BadQuoteToken();
    error BadWindow(uint40 start, uint40 expiry);
    error BadSaleEnd(uint40 saleEnd);
    error BadInterval(uint32 sampleInterval);
    error BadSampleCount(uint256 samples);
    error BadNotional();
    error BadCap(uint64 capVariance);
    error BadAnchor(uint64 anchorVariance);
    error BadImpact(uint64 impactPerUnit);
    error BadSpread(uint16 halfSpreadBps);
    error BadHalfLife(uint32 halfLife);
    error BadMaxUnits();
    error LiabilityOutOfRange(uint256 liability);
    error DemoOnly();
    error BadWiring();
    error SeriesNotFound(uint256 seriesId);
    error NotWriter(address expected, address actual);
    error UnknownVault(address vault);
    error VaultAlreadyExists(address vault);
    error NotEngine(address caller);
    error NotAccumulator(address caller);
    error NotSeriesReceipt(address caller);
    error UnknownOrderHash(bytes32 orderHash);
    error OrderHashCollision(bytes32 orderHash);
    error ShippedHashMismatch(bytes32 expected, bytes32 actual);
    error IssuanceClosed(uint256 seriesId);
    error AlreadyFinalized(uint256 seriesId);
    error NotFinalized(uint256 seriesId);
    error ExitWindowClosed(uint256 seriesId);
    error WrongLeg(Leg leg);
    error UnitsExceedOutstanding(uint256 units, uint256 outstanding);
    error PayoutExceedsReleasedLiability(uint256 amountOut, uint256 released);
    error ZeroUnits();
    error PayoutNotZero(uint256 payoutPerUnit);
    error ClaimsOutstanding(uint256 outstanding);
    error AlreadyClosed(uint256 seriesId);
    error SaleStillOpen(uint40 saleEnd);

    // ------------------------------------------------------------------ events

    event VaultCreated(address indexed writer, address indexed quoteToken, address vault);
    event SeriesCreated(
        uint256 indexed seriesId,
        address indexed writer,
        address indexed vault,
        address receipt,
        bytes32 issueOrderHash,
        bytes32 exitOrderHash,
        bytes32 settlementOrderHash,
        SeriesParams params
    );
    event Issued(
        uint256 indexed seriesId,
        address indexed buyer,
        uint256 units,
        uint256 premium,
        uint256 newOutstanding,
        uint256 newLocked
    );
    event Exited(
        uint256 indexed seriesId,
        address indexed holder,
        uint256 units,
        uint256 amountOut,
        uint256 newOutstanding,
        uint256 newLocked
    );
    event Settled(
        uint256 indexed seriesId,
        address indexed holder,
        uint256 units,
        uint256 amountOut,
        uint256 newOutstanding,
        uint256 newLocked
    );
    event Finalized(
        uint256 indexed seriesId,
        uint256 finalVariance,
        uint256 cappedVariance,
        uint256 payoutPerUnit,
        uint256 outstandingUnits,
        uint256 releasedCollateral
    );
    event IssuanceStopped(uint256 indexed seriesId, address indexed writer);
    event WorthlessBurned(uint256 indexed seriesId, address indexed holder, uint256 units);
    event SeriesClosed(uint256 indexed seriesId, uint256 unsoldBurned, uint256 releasedCollateral);

    // ------------------------------------------------------------------ constants and bounds

    uint32 public constant MIN_INTERVAL = 300;
    uint256 public constant MIN_SAMPLES = 2;
    uint256 public constant MAX_SAMPLES = 256;
    uint64 public constant MAX_CAP_VARIANCE = 4e18;
    uint16 public constant MIN_HALF_SPREAD_BPS = 10;
    uint16 public constant MAX_HALF_SPREAD_BPS = 2_000;
    uint32 public constant MIN_HALF_LIFE = 300;
    uint32 public constant MAX_HALF_LIFE = 30 days;

    // ------------------------------------------------------------------ immutables

    address public immutable ROUTER;
    address public immutable AQUA;
    address public immutable FEED;
    address public immutable QUOTE_TOKEN;
    address public immutable ENGINE;
    address public immutable ACCUMULATOR;
    TremorSeriesDeployer public immutable DEPLOYER;

    // ------------------------------------------------------------------ state

    struct Series {
        address writer;
        address vault;
        address receipt;
        bytes32 issueOrderHash;
        bytes32 exitOrderHash;
        bytes32 settlementOrderHash;
        SeriesParams params;
        uint256 outstandingUnits;
        uint256 lockedLiability;
        uint256 finalVariance;
        uint256 payoutPerUnit;
        int192 signedSkew;
        uint64 lastSkewTimestamp;
        bool issuanceStopped;
        bool issueDocked;
        bool finalized;
        bool closed;
    }

    struct OrderRef {
        uint256 seriesId;
        Leg leg;
    }

    uint256 public seriesCount;
    mapping(uint256 seriesId => Series) internal _series;
    mapping(bytes32 orderHash => OrderRef) internal _orderRef;
    mapping(address writer => address vault) public vaultOf;
    mapping(address vault => bool) public isVault;

    constructor(address router, address aqua, address feed, address quoteToken) {
        require(
            router.code.length > 0 && aqua.code.length > 0 && feed.code.length > 0 && quoteToken.code.length > 0,
            BadWiring()
        );
        require(IERC20Metadata(quoteToken).decimals() == 6, BadQuoteToken());
        require(IAggregatorV3(feed).decimals() <= 18, BadFeed());
        ROUTER = router;
        AQUA = aqua;
        FEED = feed;
        QUOTE_TOKEN = quoteToken;
        // Children are created here so each records this contract's final address as an immutable.
        ACCUMULATOR = address(new VarianceAccumulator(address(this), feed));
        ENGINE = address(new TremorMarketEngine(address(this), ACCUMULATOR, router));
        DEPLOYER = new TremorSeriesDeployer(quoteToken, aqua, router);
    }

    modifier onlyEngine() {
        require(msg.sender == ENGINE, NotEngine(msg.sender));
        _;
    }

    modifier onlyAccumulator() {
        require(msg.sender == ACCUMULATOR, NotAccumulator(msg.sender));
        _;
    }

    // ------------------------------------------------------------------ vaults

    /// @notice Address the caller's vault has, or will have. Pure function of the deployer's address.
    function predictVault(address writer) public view returns (address) {
        return DEPLOYER.predictVault(writer);
    }

    /// @notice Deploy the caller's protected maker vault, or return the one they already have.
    /// @dev Idempotent by design: the UI's "create or load vault" step and a writer's second series must
    ///   both be safe to call, and a revert here would be an avoidable dead end.
    function createVault() external returns (address vault) {
        vault = vaultOf[msg.sender];
        if (vault != address(0)) return vault;
        vault = DEPLOYER.deployVault(msg.sender);
        require(!isVault[vault], VaultAlreadyExists(vault));
        vaultOf[msg.sender] = vault;
        isVault[vault] = true;
        emit VaultCreated(msg.sender, QUOTE_TOKEN, vault);
    }

    // ------------------------------------------------------------------ series creation

    function createSeries(address vault, SeriesParams calldata p) external returns (uint256 seriesId, address receipt) {
        _validate(p, false);
        return _create(vault, p);
    }

    /// @notice Local-fork-only path for demonstrating finalization against already-known Chainlink history.
    /// @dev Never available on a public chain; production creation always requires `saleEnd <= expiry`.
    function createBackdatedDemoSeries(address vault, SeriesParams calldata p)
        external
        returns (uint256 seriesId, address receipt)
    {
        require(block.chainid == 31_337, DemoOnly());
        _validate(p, true);
        return _create(vault, p);
    }

    function _create(address vault, SeriesParams calldata p) internal returns (uint256 seriesId, address receipt) {
        require(isVault[vault], UnknownVault(vault));
        address writer = ITremorMakerVault(vault).OWNER();
        require(writer == msg.sender, NotWriter(writer, msg.sender));

        seriesId = ++seriesCount;
        receipt = DEPLOYER.deployReceipt(seriesId, p.expiry, vault, p.maxUnits);

        SeriesParams memory pm = p;
        bytes32 issueHash =
            TremorOrderBuilder.orderHash(TremorOrderBuilder.issueOrder(pm, seriesId, receipt, vault, ENGINE));
        bytes32 exitHash =
            TremorOrderBuilder.orderHash(TremorOrderBuilder.exitOrder(pm, seriesId, receipt, vault, ENGINE));
        bytes32 settleHash =
            TremorOrderBuilder.orderHash(TremorOrderBuilder.settlementOrder(pm, seriesId, receipt, vault, ENGINE));

        Series storage s = _series[seriesId];
        s.writer = writer;
        s.vault = vault;
        s.receipt = receipt;
        s.issueOrderHash = issueHash;
        s.exitOrderHash = exitHash;
        s.settlementOrderHash = settleHash;
        s.params = p;
        s.lastSkewTimestamp = uint64(block.timestamp);

        _register(issueHash, seriesId, Leg.ISSUE);
        _register(exitHash, seriesId, Leg.EXIT);
        _register(settleHash, seriesId, Leg.SETTLE);

        ITremorMakerVault(vault).registerAndApproveReceipt(receipt);
        _shipAll(seriesId, s);

        emit SeriesCreated(seriesId, writer, vault, receipt, issueHash, exitHash, settleHash, p);

        // Seed the window's opening sample if the window is already open, so a series whose observation
        // period starts immediately is tradeable in the same transaction. Everything after this point is
        // permissionless: nothing here gives creation any privilege the accumulator would not grant a
        // stranger calling `checkpoint` one block later.
        if (p.start <= block.timestamp) IVarianceAccumulator(ACCUMULATOR).checkpoint(seriesId, 1);
    }

    /// @dev Ships all three strategies and asserts Aqua agreed on every hash, so the registry, the Aqua
    ///   strategy and `router.hash(order)` are the same bytes32 by verification rather than by assumption.
    ///   No collateral is reserved here: the EXIT/SETTLE virtual balances are Aqua accounting, and
    ///   `lockedLiability` stays zero until the first unit is actually sold.
    function _shipAll(uint256 seriesId, Series storage s) internal {
        SeriesParams memory p = s.params;
        address vault = s.vault;
        address receipt = s.receipt;
        uint256 liability = VariancePricing.maxLiability(p.maxUnits, p.unitNotional, p.capVariance);
        address[] memory tokens = TremorOrderBuilder.sortedTokens(p.quoteToken, receipt);

        bytes32 shipped = ITremorMakerVault(vault)
            .shipStrategy(
                TremorOrderBuilder.shipBytes(TremorOrderBuilder.issueOrder(p, seriesId, receipt, vault, ENGINE)),
                tokens,
                TremorOrderBuilder.shipAmounts(p, receipt, Leg.ISSUE, liability)
            );
        require(shipped == s.issueOrderHash, ShippedHashMismatch(s.issueOrderHash, shipped));

        shipped = ITremorMakerVault(vault)
            .shipStrategy(
                TremorOrderBuilder.shipBytes(TremorOrderBuilder.exitOrder(p, seriesId, receipt, vault, ENGINE)),
                tokens,
                TremorOrderBuilder.shipAmounts(p, receipt, Leg.EXIT, liability)
            );
        require(shipped == s.exitOrderHash, ShippedHashMismatch(s.exitOrderHash, shipped));

        shipped = ITremorMakerVault(vault)
            .shipStrategy(
                TremorOrderBuilder.shipBytes(TremorOrderBuilder.settlementOrder(p, seriesId, receipt, vault, ENGINE)),
                tokens,
                TremorOrderBuilder.shipAmounts(p, receipt, Leg.SETTLE, liability)
            );
        require(shipped == s.settlementOrderHash, ShippedHashMismatch(s.settlementOrderHash, shipped));
    }

    // ------------------------------------------------------------------ engine callbacks

    /// @inheritdoc ITremorController
    function onIssue(uint256 seriesId, address buyer, uint256 units, uint256 premium) external onlyEngine {
        Series storage s = _get(seriesId);
        require(units > 0, ZeroUnits());
        require(!s.issuanceStopped && !s.finalized && block.timestamp <= s.params.saleEnd, IssuanceClosed(seriesId));

        uint256 newOutstanding = s.outstandingUnits + units;
        uint256 newLiability = VariancePricing.maxLiability(newOutstanding, s.params.unitNotional, s.params.capVariance);
        uint256 delta = newLiability - s.lockedLiability;

        s.outstandingUnits = newOutstanding;
        s.lockedLiability = newLiability;
        _skew(s, int256(_impactDelta(units, s.params.impactPerUnit)));

        // Reserve before any token moves. The premium is not counted toward this: an issuance has to be
        // collateralised by capital that was already in the vault.
        ITremorMakerVault(s.vault).increaseLocked(delta);

        emit Issued(seriesId, buyer, units, premium, newOutstanding, newLiability);
    }

    /// @inheritdoc ITremorController
    function onExit(uint256 seriesId, uint256 units) external onlyEngine {
        Series storage s = _get(seriesId);
        require(units > 0, ZeroUnits());
        require(!s.finalized && block.timestamp < s.params.expiry, ExitWindowClosed(seriesId));
        _skew(s, -int256(_impactDelta(units, s.params.impactPerUnit)));
    }

    // ------------------------------------------------------------------ receipt callback

    /// @inheritdoc ITremorController
    function onBurn(bytes32 orderHash, address holder, uint256 units, uint256 amountOut) external {
        OrderRef memory ref = _orderRef[orderHash];
        require(ref.leg == Leg.EXIT || ref.leg == Leg.SETTLE, WrongLeg(ref.leg));
        Series storage s = _get(ref.seriesId);
        require(msg.sender == s.receipt, NotSeriesReceipt(msg.sender));
        require(units > 0, ZeroUnits());
        require(units <= s.outstandingUnits, UnitsExceedOutstanding(units, s.outstandingUnits));

        uint256 newOutstanding = s.outstandingUnits - units;
        uint256 newLiability;
        if (ref.leg == Leg.EXIT) {
            require(!s.finalized && block.timestamp < s.params.expiry, ExitWindowClosed(ref.seriesId));
            newLiability = VariancePricing.maxLiability(newOutstanding, s.params.unitNotional, s.params.capVariance);
        } else {
            require(s.finalized, NotFinalized(ref.seriesId));
            newLiability = VariancePricing.finalLiability(newOutstanding, s.payoutPerUnit);
        }

        uint256 released = s.lockedLiability - newLiability;
        require(amountOut <= released, PayoutExceedsReleasedLiability(amountOut, released));

        s.outstandingUnits = newOutstanding;
        s.lockedLiability = newLiability;
        ITremorMakerVault(s.vault).decreaseLocked(released);

        if (ref.leg == Leg.EXIT) {
            emit Exited(ref.seriesId, holder, units, amountOut, newOutstanding, newLiability);
        } else {
            emit Settled(ref.seriesId, holder, units, amountOut, newOutstanding, newLiability);
        }
    }

    // ------------------------------------------------------------------ accumulator callback

    /// @inheritdoc ITremorController
    function onFinalize(uint256 seriesId, uint256 finalVariance) external onlyAccumulator {
        Series storage s = _get(seriesId);
        require(!s.finalized, AlreadyFinalized(seriesId));

        uint64 cap = s.params.capVariance;
        uint256 capped = finalVariance < cap ? finalVariance : cap;
        uint256 ppu = VariancePricing.payoutPerUnit(finalVariance, cap, s.params.unitNotional);

        s.finalized = true;
        s.finalVariance = finalVariance;
        s.payoutPerUnit = ppu;

        // The cap surplus is the writer's the moment the variance is known; it can no longer be owed.
        uint256 newLiability = VariancePricing.finalLiability(s.outstandingUnits, ppu);
        uint256 released = s.lockedLiability - newLiability;
        s.lockedLiability = newLiability;
        if (released > 0) ITremorMakerVault(s.vault).decreaseLocked(released);

        emit Finalized(seriesId, finalVariance, capped, ppu, s.outstandingUnits, released);
    }

    // ------------------------------------------------------------------ writer and lifecycle actions

    /// @notice Permanently stop new issuance and dock only the ISSUE strategy.
    /// @dev EXIT and SETTLE stay shipped. A writer who wants out of a market can stop selling; they cannot
    ///   stop paying.
    function stopIssuance(uint256 seriesId) external {
        Series storage s = _get(seriesId);
        require(msg.sender == s.writer, NotWriter(s.writer, msg.sender));
        require(!s.issuanceStopped, IssuanceClosed(seriesId));
        s.issuanceStopped = true;
        _dockIssue(s);
        emit IssuanceStopped(seriesId, s.writer);
    }

    /// @notice Burn worthless receipts once the series finalized at a payout of zero.
    /// @dev SwapVM rejects a swap with `amountOut == 0`, so a zero-payout series cannot be redeemed through
    ///   the SETTLE leg at all. This is the explicit path out, callable by the holder, so a zero-variance
    ///   series can still reach `outstandingUnits == 0` and close.
    function burnWorthless(uint256 seriesId, uint256 units) external {
        Series storage s = _get(seriesId);
        require(s.finalized, NotFinalized(seriesId));
        require(s.payoutPerUnit == 0, PayoutNotZero(s.payoutPerUnit));
        require(units > 0, ZeroUnits());
        require(units <= s.outstandingUnits, UnitsExceedOutstanding(units, s.outstandingUnits));
        VarianceReceipt(s.receipt).burnFromHolder(msg.sender, units);
        s.outstandingUnits -= units;
        emit WorthlessBurned(seriesId, msg.sender, units);
    }

    /// @notice Close a series nobody holds a claim on: dock its remaining strategies, burn the unsold
    ///   inventory and release the rounding residual. Callable by anyone.
    function closeSeries(uint256 seriesId) external {
        Series storage s = _get(seriesId);
        require(!s.closed, AlreadyClosed(seriesId));
        require(s.outstandingUnits == 0, ClaimsOutstanding(s.outstandingUnits));
        require(s.issuanceStopped || block.timestamp > s.params.saleEnd, SaleStillOpen(s.params.saleEnd));

        s.closed = true;
        _dockIssue(s);
        address[] memory tokens = TremorOrderBuilder.sortedTokens(s.params.quoteToken, s.receipt);
        ITremorMakerVault(s.vault).dockStrategy(s.exitOrderHash, tokens);
        ITremorMakerVault(s.vault).dockStrategy(s.settlementOrderHash, tokens);

        uint256 unsold = IERC20(s.receipt).balanceOf(s.vault);
        if (unsold > 0) VarianceReceipt(s.receipt).burnUnsoldInventory(unsold);

        uint256 residual = s.lockedLiability;
        if (residual > 0) {
            s.lockedLiability = 0;
            ITremorMakerVault(s.vault).decreaseLocked(residual);
        }

        emit SeriesClosed(seriesId, unsold, residual);
    }

    // ------------------------------------------------------------------ views

    function seriesParams(uint256 seriesId) external view returns (SeriesParams memory) {
        return _get(seriesId).params;
    }

    function seriesView(uint256 seriesId) external view returns (SeriesView memory v) {
        Series storage s = _get(seriesId);
        v = SeriesView({
            writer: s.writer,
            vault: s.vault,
            receipt: s.receipt,
            outstandingUnits: s.outstandingUnits,
            lockedLiability: s.lockedLiability,
            issuanceStopped: s.issuanceStopped,
            finalized: s.finalized,
            finalVariance: s.finalVariance,
            payoutPerUnit: s.payoutPerUnit,
            signedSkew: s.signedSkew,
            lastSkewTimestamp: s.lastSkewTimestamp
        });
    }

    function orderLeg(bytes32 orderHash) external view returns (uint256 seriesId, Leg leg) {
        OrderRef memory ref = _orderRef[orderHash];
        return (ref.seriesId, ref.leg);
    }

    function series(uint256 seriesId)
        external
        view
        returns (
            address writer,
            address vault,
            address receipt,
            bytes32 issueOrderHash,
            bytes32 exitOrderHash,
            bytes32 settlementOrderHash,
            SeriesParams memory params
        )
    {
        Series storage s = _get(seriesId);
        return (s.writer, s.vault, s.receipt, s.issueOrderHash, s.exitOrderHash, s.settlementOrderHash, s.params);
    }

    /// @dev The three orders and the Aqua ship plan are rebuilt by `TremorPrograms`, a stateless read
    ///   model that calls the same `TremorOrderBuilder` this contract used at creation. Keeping those six
    ///   `MakerTraits` build sites out of the controller is what keeps its initcode inside EIP-3860, and it
    ///   is not a second encoding path: `ShipRoundTrip` asserts the orders it returns hash to the bytes32
    ///   pinned here and shipped to Aqua.

    /// @notice Maximum collateral a series can ever owe, i.e. what its EXIT/SETTLE legs are shipped with.
    function maxSeriesLiability(SeriesParams memory p) public pure returns (uint256) {
        return VariancePricing.maxLiability(p.maxUnits, p.unitNotional, p.capVariance);
    }

    function isClosed(uint256 seriesId) external view returns (bool) {
        return _get(seriesId).closed;
    }

    // ------------------------------------------------------------------ internals

    function _get(uint256 seriesId) internal view returns (Series storage s) {
        s = _series[seriesId];
        require(s.writer != address(0), SeriesNotFound(seriesId));
    }

    function _register(bytes32 orderHash, uint256 seriesId, Leg leg) internal {
        require(_orderRef[orderHash].leg == Leg.NONE, OrderHashCollision(orderHash));
        _orderRef[orderHash] = OrderRef({seriesId: seriesId, leg: leg});
    }

    function _dockIssue(Series storage s) internal {
        if (s.issueDocked) return;
        s.issueDocked = true;
        ITremorMakerVault(s.vault)
            .dockStrategy(s.issueOrderHash, TremorOrderBuilder.sortedTokens(s.params.quoteToken, s.receipt));
    }

    /// @dev Decays the stored skew to now and applies `delta`, then rewrites the timestamp. Clamping to the
    ///   pricing boundaries happens in `VariancePricing.forwardVariance`, not here, so the stored skew stays
    ///   a faithful record of net inventory rather than a saturated one.
    function _skew(Series storage s, int256 delta) internal {
        int256 decayed =
            VariancePricing.decaySkew(s.signedSkew, block.timestamp - s.lastSkewTimestamp, s.params.halfLife);
        s.signedSkew = SafeCast.toInt192(decayed + delta);
        s.lastSkewTimestamp = uint64(block.timestamp);
    }

    /// @dev `units * impactPerUnit / 1e18`, floored.
    function _impactDelta(uint256 units, uint64 impactPerUnit) private pure returns (uint256) {
        return units * impactPerUnit / VariancePricing.WAD;
    }

    function _validate(SeriesParams calldata p, bool allowBackdated) internal view {
        require(p.feed == FEED, BadFeed());
        require(p.quoteToken == QUOTE_TOKEN, BadQuoteToken());
        require(p.expiry > p.start, BadWindow(p.start, p.expiry));
        require(p.sampleInterval >= MIN_INTERVAL, BadInterval(p.sampleInterval));
        require((uint256(p.expiry) - p.start) % p.sampleInterval == 0, BadInterval(p.sampleInterval));
        uint256 samples = (uint256(p.expiry) - p.start) / p.sampleInterval;
        require(samples >= MIN_SAMPLES && samples <= MAX_SAMPLES, BadSampleCount(samples));
        require(p.saleEnd >= block.timestamp, BadSaleEnd(p.saleEnd));
        require(p.start <= p.saleEnd, BadSaleEnd(p.saleEnd));
        if (!allowBackdated) require(p.saleEnd <= p.expiry, BadSaleEnd(p.saleEnd));
        require(p.unitNotional > 0, BadNotional());
        require(p.capVariance > 0 && p.capVariance <= MAX_CAP_VARIANCE, BadCap(p.capVariance));
        require(p.anchorVariance > 0 && p.anchorVariance <= p.capVariance, BadAnchor(p.anchorVariance));
        require(p.impactPerUnit <= p.capVariance, BadImpact(p.impactPerUnit));
        require(
            p.halfSpreadBps >= MIN_HALF_SPREAD_BPS && p.halfSpreadBps <= MAX_HALF_SPREAD_BPS, BadSpread(p.halfSpreadBps)
        );
        require(
            p.halfLife == 0 || (p.halfLife >= MIN_HALF_LIFE && p.halfLife <= MAX_HALF_LIFE), BadHalfLife(p.halfLife)
        );
        require(p.maxUnits > 0, BadMaxUnits());
        uint256 liability = VariancePricing.maxLiability(p.maxUnits, p.unitNotional, p.capVariance);
        require(liability > 0 && liability <= type(uint248).max, LiabilityOutOfRange(liability));
    }
}
