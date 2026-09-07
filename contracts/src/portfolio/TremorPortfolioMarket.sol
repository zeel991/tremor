// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";
import {SwapQuery, SwapRegisters} from "swap-vm/libs/VM.sol";
import {IExtruction} from "swap-vm/instructions/Extruction.sol";

import {SeriesParams} from "../libs/SeriesParams.sol";
import {ITremorMakerVault} from "../interfaces/ITremorMakerVault.sol";
import {IVarianceAccumulator} from "../interfaces/IVarianceAccumulator.sol";
import {TremorSeriesDeployer} from "../TremorSeriesDeployer.sol";
import {VarianceAccumulator} from "../VarianceAccumulator.sol";
import {VarianceReceipt} from "../tokens/VarianceReceipt.sol";
import {PortfolioMath} from "./PortfolioMath.sol";
import {PortfolioOrderBuilder as POB} from "./PortfolioOrderBuilder.sol";

/// @notice Tremor v3 portfolio experiment: one risk group backs two complementary capped claims — HIGH
///   (pays `S*x`) and CALM (pays `S*(1-x)`) on the same finalized normalized outcome
///   `x = min(realizedVariance / capVariance, 1)` — with a shared reserve of `ceil(max(h,c)*S/1e18)`
///   instead of the `h*S + c*S` two separate full-cap series would lock.
///
///   This contract is the controller AND the `Extruction` pricing target for all six of a group's SwapVM
///   programs (ISSUE/EXIT/SETTLE per side), each a stock `Salt`/`Deadline`/`Extruction` program on the
///   unmodified official `AquaSwapVMRouter`. It is deliberately a separate versioned deployment: v2 series,
///   vaults and receipts stay associated with their own controller and are never redirected here.
///
///   The core invariant, preserved by every transition:
///
///     vault quote balance  >=  vault.lockedQuote  ==  sum over groups of (reserveLocked + exitBuffer)
///     reserveLocked        >=  maximum aggregate payout of the group's outstanding claims
///
///   Exits are the sharp edge. Burning a claim of the smaller side releases ZERO reserve (max(h,c) is
///   unchanged), so an exit is payable only from (a) reserve actually released by this burn plus (b) the
///   group's `exitBuffer` — collateral the writer explicitly locked to fund buybacks. Exits never spend
///   the vault's free balance directly: free headroom read during a fill could be double-spent by a taker
///   callback interleaving a second fill before this one's transfers settle, whereas the buffer is storage
///   debited inside the burn hook itself and re-checked there, so a raced exit fails closed.
///
///   Quote and swap run byte-identical arithmetic; `isStaticContext == false` only adds the issuance
///   ledger/lock mutation. Exit and settle mutations happen exclusively in `onBurn`, reached through the
///   receipt's router-only `postTransferIn` hook — a program that omits the hook cannot exist for these
///   orders because the hook is part of the shipped, hash-pinned order itself.
contract TremorPortfolioMarket is IExtruction {
    using PortfolioMath for uint256;

    // ------------------------------------------------------------------ errors

    error BadWiring();
    error NotRouter(address caller);
    error NotAccumulator(address caller);
    error NotWriter(address expected, address actual);
    error UnknownVault(address vault);
    error GroupNotFound(uint256 groupId);
    error BadArgsLength(uint256 length);
    error UnsupportedArgsVersion(uint8 version);
    error OrderNotRegistered(bytes32 orderHash, uint256 claimedGroup, POB.PMode claimedMode);
    error MakerNotVault(address maker, address vault);
    error WrongDirection(address tokenIn, address tokenOut);
    error RecomputeDetected();
    error ExactOutUnsupported(POB.PMode mode);
    error IssuanceClosed(uint256 groupId);
    error ExitWindowClosed(uint256 groupId);
    error NotFinalized(uint256 groupId);
    error AlreadyFinalized(uint256 groupId);
    error NothingToFill(uint256 groupId, POB.PMode mode);
    error ExitUnderfunded(uint256 groupId, uint256 needed, uint256 available);
    error ZeroPayout(uint256 groupId, POB.PMode mode);
    error PayoutNotZero(uint256 ppu);
    error ZeroUnits();
    error ZeroAmount();
    error UnitsExceedOutstanding(uint256 units, uint256 outstanding);
    error PayoutExceedsRelease(uint256 amountOut, uint256 released);
    error ExceedsBuffer(uint256 requested, uint256 buffer);
    error NotGroupReceipt(address caller);
    error WrongMode(POB.PMode mode);
    error ShippedHashMismatch(bytes32 expected, bytes32 actual);
    error OrderHashCollision(bytes32 orderHash);
    error BadWindow();
    error BadSaleEnd();
    error BadInterval();
    error BadSampleCount(uint256 samples);
    error BadCap(uint64 capVariance);
    error BadScale();
    error BadMaxUnits();
    error BadPrices();
    error DemoOnly();

    // ------------------------------------------------------------------ events

    event VaultCreated(address indexed writer, address vault);
    event GroupCreated(
        uint256 indexed groupId,
        address indexed writer,
        address indexed vault,
        address highReceipt,
        address calmReceipt,
        GroupParams params
    );
    event PortfolioIssued(
        uint256 indexed groupId,
        address indexed buyer,
        bool high,
        uint256 units,
        uint256 premium,
        uint256 highOutstanding,
        uint256 calmOutstanding,
        uint256 reserveLocked
    );
    event PortfolioExited(
        uint256 indexed groupId,
        address indexed holder,
        bool high,
        uint256 units,
        uint256 amountOut,
        uint256 reserveReleased,
        uint256 bufferDrawn,
        uint256 reserveLocked
    );
    event PortfolioSettled(
        uint256 indexed groupId,
        address indexed holder,
        bool high,
        uint256 units,
        uint256 amountOut,
        uint256 reserveLocked
    );
    event GroupFinalized(
        uint256 indexed groupId,
        uint256 finalVariance,
        uint256 xWad,
        uint256 highPayoutPerUnit,
        uint256 calmPayoutPerUnit,
        uint256 releasedCollateral
    );
    event ExitBufferFunded(uint256 indexed groupId, address indexed payer, uint256 amount, uint256 newBuffer);
    event ExitBufferWithdrawn(uint256 indexed groupId, uint256 amount, uint256 newBuffer);
    event WorthlessBurned(uint256 indexed groupId, address indexed holder, bool high, uint256 units);

    // ------------------------------------------------------------------ types

    /// @param capPayoutPerUnit `S`: quote base units one 1e18-unit claim pays at its cap. HIGH pays `S*x`,
    ///   CALM pays `S*(1-x)`; the two per-unit payouts sum to exactly `S` by construction.
    /// @param askHigh/bidHigh/askCalm/bidCalm the writer's fixed executable quotes per 1e18 units. This is
    ///   deliberately a simple explicit pricing model: quotes are the writer's prices, not fair values, and
    ///   solvency never depends on them.
    struct GroupParams {
        address feed;
        address quoteToken;
        uint40 start;
        uint40 expiry;
        uint40 saleEnd;
        uint32 sampleInterval;
        uint64 capVariance;
        uint128 capPayoutPerUnit;
        uint128 maxUnitsPerSide;
        uint128 askHigh;
        uint128 bidHigh;
        uint128 askCalm;
        uint128 bidCalm;
    }

    struct Group {
        address writer;
        address vault;
        address highReceipt;
        address calmReceipt;
        GroupParams params;
        uint256 highOutstanding;
        uint256 calmOutstanding;
        uint256 reserveLocked;
        uint256 exitBuffer;
        bool finalized;
        uint256 finalVariance;
        uint256 xWad;
        uint256 highPpu;
        uint256 calmPpu;
        bytes32[6] orderHashes; // indexed by uint8(PMode) - 1
    }

    struct OrderRef {
        uint256 groupId;
        POB.PMode mode;
    }

    // ------------------------------------------------------------------ storage

    uint32 public constant MIN_INTERVAL = 300;
    uint256 public constant MIN_SAMPLES = 2;
    uint256 public constant MAX_SAMPLES = 256;
    uint64 public constant MAX_CAP_VARIANCE = 4e18;

    address public immutable ROUTER;
    address public immutable AQUA;
    address public immutable FEED;
    address public immutable QUOTE_TOKEN;
    address public immutable ACCUMULATOR;
    TremorSeriesDeployer public immutable DEPLOYER;

    uint256 public groupCount;
    mapping(uint256 => Group) internal _groups;
    mapping(bytes32 => OrderRef) internal _orderRef;
    mapping(address writer => address vault) public vaultOf;
    mapping(address vault => bool) public isVault;

    constructor(address router, address aqua, address feed, address quoteToken) {
        require(
            router.code.length > 0 && aqua.code.length > 0 && feed.code.length > 0 && quoteToken.code.length > 0,
            BadWiring()
        );
        ROUTER = router;
        AQUA = aqua;
        FEED = feed;
        QUOTE_TOKEN = quoteToken;
        ACCUMULATOR = address(new VarianceAccumulator(address(this), feed));
        // Holds the vault and receipt creation code so this contract's runtime stays inside EIP-170.
        DEPLOYER = new TremorSeriesDeployer(quoteToken, aqua, router);
    }

    modifier onlyAccumulator() {
        require(msg.sender == ACCUMULATOR, NotAccumulator(msg.sender));
        _;
    }

    // ------------------------------------------------------------------ vaults

    function createVault() external returns (address vault) {
        vault = vaultOf[msg.sender];
        if (vault != address(0)) return vault;
        vault = DEPLOYER.deployVault(msg.sender);
        vaultOf[msg.sender] = vault;
        isVault[vault] = true;
        emit VaultCreated(msg.sender, vault);
    }

    // ------------------------------------------------------------------ group creation

    function createGroup(address vault, GroupParams calldata p) external returns (uint256 groupId) {
        _validate(p, false);
        return _create(vault, p);
    }

    /// @notice Local-fork-only path for demonstrating finalization against known feed history.
    function createBackdatedDemoGroup(address vault, GroupParams calldata p) external returns (uint256 groupId) {
        require(block.chainid == 31_337, DemoOnly());
        _validate(p, true);
        return _create(vault, p);
    }

    function _create(address vault, GroupParams calldata p) internal returns (uint256 groupId) {
        require(isVault[vault], UnknownVault(vault));
        address writer = ITremorMakerVault(vault).OWNER();
        require(writer == msg.sender, NotWriter(writer, msg.sender));

        groupId = ++groupCount;
        Group storage g = _groups[groupId];
        g.writer = writer;
        g.vault = vault;
        g.params = p;
        g.highReceipt = DEPLOYER.deployReceipt(groupId, p.expiry, vault, p.maxUnitsPerSide);
        g.calmReceipt = DEPLOYER.deployReceipt(groupId, p.expiry, vault, p.maxUnitsPerSide);

        ITremorMakerVault(vault).registerAndApproveReceipt(g.highReceipt);
        ITremorMakerVault(vault).registerAndApproveReceipt(g.calmReceipt);

        uint256 maxLiability = PortfolioMath.reserve(p.maxUnitsPerSide, 0, p.capPayoutPerUnit);
        for (uint8 m = uint8(POB.PMode.ISSUE_HIGH); m <= uint8(POB.PMode.SETTLE_CALM); m++) {
            POB.PMode mode = POB.PMode(m);
            address receipt = POB.isHigh(mode) ? g.highReceipt : g.calmReceipt;
            ISwapVM.Order memory o =
                POB.order(mode, groupId, p.quoteToken, receipt, vault, address(this), p.saleEnd, p.expiry);
            bytes32 h = POB.orderHash(o);
            require(_orderRef[h].mode == POB.PMode.NONE, OrderHashCollision(h));
            _orderRef[h] = OrderRef({groupId: groupId, mode: mode});
            g.orderHashes[m - 1] = h;
            bytes32 shipped = ITremorMakerVault(vault)
                .shipStrategy(
                    POB.shipBytes(o),
                    POB.sortedTokens(p.quoteToken, receipt),
                    POB.shipAmounts(mode, p.quoteToken, receipt, p.maxUnitsPerSide, maxLiability)
                );
            require(shipped == h, ShippedHashMismatch(h, shipped));
        }

        emit GroupCreated(groupId, writer, vault, g.highReceipt, g.calmReceipt, p);

        // Seed the window's opening sample if the window is already open, exactly as v2 does; everything
        // after this point is permissionless.
        if (p.start <= block.timestamp) IVarianceAccumulator(ACCUMULATOR).checkpoint(groupId, 1);
    }

    // ------------------------------------------------------------------ IExtruction

    /// @inheritdoc IExtruction
    /// @dev `msg.sender == ROUTER` is load-bearing: only the router guarantees the `query` describes an
    ///   order that is genuinely executing. Without it, anyone could hand this function a fabricated query
    ///   naming a real order hash and the real vault and mutate the ledger with no tokens moving.
    function extruction(
        bool isStaticContext,
        uint256 nextPC,
        SwapQuery calldata query,
        SwapRegisters calldata swap,
        bytes calldata args,
        bytes calldata /* takerData */
    ) external returns (uint256 updatedNextPC, uint256 choppedLength, SwapRegisters memory updatedSwap) {
        require(msg.sender == ROUTER, NotRouter(msg.sender));
        require(args.length == 10, BadArgsLength(args.length));
        (uint8 version, POB.PMode mode, uint256 groupId) = POB.parseArgs(args);
        require(version == POB.ARGS_VERSION, UnsupportedArgsVersion(version));

        Group storage g = _auth(query, mode, groupId);
        updatedSwap = swap;

        if (POB.isIssue(mode)) {
            (uint256 units, uint256 premium) = _priceIssue(g, mode, groupId, query, updatedSwap);
            if (!isStaticContext) _applyIssue(g, mode, groupId, query.taker, units, premium);
        } else if (POB.isExit(mode)) {
            _priceExit(g, mode, groupId, query, updatedSwap);
            // State moves in onBurn, via the receipt's router-only postTransferIn hook.
        } else {
            _priceSettle(g, mode, groupId, query, updatedSwap);
        }

        return (nextPC, 0, updatedSwap);
    }

    // ------------------------------------------------------------------ pricing

    function _priceIssue(
        Group storage g,
        POB.PMode mode,
        uint256 groupId,
        SwapQuery calldata query,
        SwapRegisters memory swap
    ) internal view returns (uint256 units, uint256 premium) {
        require(!g.finalized && block.timestamp <= g.params.saleEnd, IssuanceClosed(groupId));
        bool high = POB.isHigh(mode);
        uint256 ask = high ? g.params.askHigh : g.params.askCalm;
        uint256 self = high ? g.highOutstanding : g.calmOutstanding;

        // Capacity: the largest this side may grow keeping reserve within reserveLocked + free collateral.
        uint256 maxSelf = PortfolioMath.maxSideUnits(
            g.reserveLocked, ITremorMakerVault(g.vault).freeQuote(), g.params.capPayoutPerUnit
        );
        uint256 capacity = maxSelf > self ? maxSelf - self : 0;
        uint256 maxFill = swap.balanceOut < capacity ? swap.balanceOut : capacity; // Aqua receipt inventory

        if (query.isExactIn) {
            require(swap.amountOut == 0, RecomputeDetected());
            units = PortfolioMath.issueUnitsFor(swap.amountIn, ask);
            premium = swap.amountIn;
            if (units > maxFill) {
                units = maxFill;
                premium = PortfolioMath.issuePremium(units, ask);
            }
            swap.amountIn = premium;
            swap.amountOut = units;
        } else {
            require(swap.amountIn == 0, RecomputeDetected());
            units = swap.amountOut > maxFill ? maxFill : swap.amountOut;
            premium = PortfolioMath.issuePremium(units, ask);
            swap.amountOut = units;
            swap.amountIn = premium;
        }
        require(units > 0, NothingToFill(groupId, mode));
    }

    function _priceExit(
        Group storage g,
        POB.PMode mode,
        uint256 groupId,
        SwapQuery calldata query,
        SwapRegisters memory swap
    ) internal view {
        require(query.isExactIn, ExactOutUnsupported(mode));
        require(swap.amountOut == 0, RecomputeDetected());
        require(!g.finalized && block.timestamp < g.params.expiry, ExitWindowClosed(groupId));

        bool high = POB.isHigh(mode);
        uint256 self = high ? g.highOutstanding : g.calmOutstanding;
        uint256 units = swap.amountIn > self ? self : swap.amountIn;
        uint256 proceeds = PortfolioMath.exitProceeds(units, high ? g.params.bidHigh : g.params.bidCalm);
        require(units > 0 && proceeds > 0, NothingToFill(groupId, mode));

        uint256 released = g.reserveLocked - _reserveAfterExit(g, high, units);
        uint256 available = released + g.exitBuffer;
        require(proceeds <= available, ExitUnderfunded(groupId, proceeds, available));
        if (proceeds > swap.balanceOut) proceeds = swap.balanceOut;
        require(proceeds > 0, NothingToFill(groupId, mode));

        swap.amountIn = units;
        swap.amountOut = proceeds;
    }

    function _priceSettle(
        Group storage g,
        POB.PMode mode,
        uint256 groupId,
        SwapQuery calldata query,
        SwapRegisters memory swap
    ) internal view {
        require(query.isExactIn, ExactOutUnsupported(mode));
        require(swap.amountOut == 0, RecomputeDetected());
        require(g.finalized, NotFinalized(groupId));

        bool high = POB.isHigh(mode);
        uint256 ppu = high ? g.highPpu : g.calmPpu;
        require(ppu > 0, ZeroPayout(groupId, mode));

        uint256 self = high ? g.highOutstanding : g.calmOutstanding;
        uint256 units = swap.amountIn > self ? self : swap.amountIn;
        uint256 proceeds = PortfolioMath.settleProceeds(units, ppu);
        require(units > 0 && proceeds > 0, NothingToFill(groupId, mode));
        if (proceeds > swap.balanceOut) proceeds = swap.balanceOut;

        swap.amountIn = units;
        swap.amountOut = proceeds;
    }

    // ------------------------------------------------------------------ issuance mutation

    function _applyIssue(
        Group storage g,
        POB.PMode mode,
        uint256 groupId,
        address buyer,
        uint256 units,
        uint256 premium
    ) internal {
        bool high = POB.isHigh(mode);
        if (high) g.highOutstanding += units;
        else g.calmOutstanding += units;

        uint256 newReserve = PortfolioMath.reserve(g.highOutstanding, g.calmOutstanding, g.params.capPayoutPerUnit);
        uint256 delta = newReserve - g.reserveLocked;
        g.reserveLocked = newReserve;
        // Reserve before any token moves; the premium is not counted toward the new reservation.
        if (delta > 0) ITremorMakerVault(g.vault).increaseLocked(delta);

        emit PortfolioIssued(groupId, buyer, high, units, premium, g.highOutstanding, g.calmOutstanding, newReserve);
    }

    // ------------------------------------------------------------------ receipt burn callback

    /// @notice `ITremorController.onBurn`-shaped hook, called by a group receipt's `postTransferIn` after the
    ///   router pushed the exited or settled units back into the vault. The ONLY place a reservation or the
    ///   exit buffer decreases for exits and settlements.
    function onBurn(bytes32 orderHash, address holder, uint256 units, uint256 amountOut) external {
        OrderRef memory ref = _orderRef[orderHash];
        require(POB.isExit(ref.mode) || POB.isSettle(ref.mode), WrongMode(ref.mode));
        Group storage g = _get(ref.groupId);
        bool high = POB.isHigh(ref.mode);
        require(msg.sender == (high ? g.highReceipt : g.calmReceipt), NotGroupReceipt(msg.sender));
        require(units > 0, ZeroUnits());
        uint256 self = high ? g.highOutstanding : g.calmOutstanding;
        require(units <= self, UnitsExceedOutstanding(units, self));

        if (POB.isExit(ref.mode)) {
            require(!g.finalized && block.timestamp < g.params.expiry, ExitWindowClosed(ref.groupId));
            uint256 newReserve = _reserveAfterExit(g, high, units);
            uint256 released = g.reserveLocked - newReserve;
            uint256 draw;
            if (amountOut > released) {
                draw = amountOut - released;
                require(draw <= g.exitBuffer, ExitUnderfunded(ref.groupId, amountOut, released + g.exitBuffer));
                g.exitBuffer -= draw;
            }
            g.reserveLocked = newReserve;
            if (high) g.highOutstanding = self - units;
            else g.calmOutstanding = self - units;
            ITremorMakerVault(g.vault).decreaseLocked(released + draw);
            emit PortfolioExited(ref.groupId, holder, high, units, amountOut, released, draw, newReserve);
        } else {
            require(g.finalized, NotFinalized(ref.groupId));
            uint256 newSelf = self - units;
            uint256 newTotal = high
                ? PortfolioMath.finalSideLiability(newSelf, g.highPpu)
                    + PortfolioMath.finalSideLiability(g.calmOutstanding, g.calmPpu)
                : PortfolioMath.finalSideLiability(g.highOutstanding, g.highPpu)
                    + PortfolioMath.finalSideLiability(newSelf, g.calmPpu);
            uint256 released = g.reserveLocked - newTotal;
            require(amountOut <= released, PayoutExceedsRelease(amountOut, released));
            g.reserveLocked = newTotal;
            if (high) g.highOutstanding = newSelf;
            else g.calmOutstanding = newSelf;
            ITremorMakerVault(g.vault).decreaseLocked(released);
            emit PortfolioSettled(ref.groupId, holder, high, units, amountOut, newTotal);
        }
    }

    // ------------------------------------------------------------------ finalization

    /// @notice `ITremorController.onFinalize`-shaped callback from the shared permissionless accumulator:
    ///   one finalized observation fixes BOTH claims' payouts, and the cap surplus over the exact final
    ///   liabilities — plus any unspent exit buffer — is released to the writer immediately.
    function onFinalize(uint256 groupId, uint256 finalVariance) external onlyAccumulator {
        Group storage g = _get(groupId);
        require(!g.finalized, AlreadyFinalized(groupId));

        uint256 xWad = PortfolioMath.normalizedOutcome(finalVariance, g.params.capVariance);
        (uint256 hp, uint256 cp) = PortfolioMath.finalPayouts(xWad, g.params.capPayoutPerUnit);

        g.finalized = true;
        g.finalVariance = finalVariance;
        g.xWad = xWad;
        g.highPpu = hp;
        g.calmPpu = cp;

        uint256 newLocked = PortfolioMath.finalSideLiability(g.highOutstanding, hp)
            + PortfolioMath.finalSideLiability(g.calmOutstanding, cp);
        uint256 released = g.reserveLocked + g.exitBuffer - newLocked;
        g.reserveLocked = newLocked;
        g.exitBuffer = 0;
        if (released > 0) ITremorMakerVault(g.vault).decreaseLocked(released);

        emit GroupFinalized(groupId, finalVariance, xWad, hp, cp, released);
    }

    /// @notice Burn a holder's worthless side once the group finalized with that side's payout at zero.
    function burnWorthless(uint256 groupId, bool high, uint256 units) external {
        Group storage g = _get(groupId);
        require(g.finalized, NotFinalized(groupId));
        uint256 ppu = high ? g.highPpu : g.calmPpu;
        require(ppu == 0, PayoutNotZero(ppu));
        require(units > 0, ZeroUnits());
        uint256 self = high ? g.highOutstanding : g.calmOutstanding;
        require(units <= self, UnitsExceedOutstanding(units, self));
        VarianceReceipt(high ? g.highReceipt : g.calmReceipt).burnFromHolder(msg.sender, units);
        if (high) g.highOutstanding = self - units;
        else g.calmOutstanding = self - units;
        emit WorthlessBurned(groupId, msg.sender, high, units);
    }

    // ------------------------------------------------------------------ exit buffer

    /// @notice Lock `amount` of the vault's free collateral as buyback funding for this group's exits.
    ///   Open to anyone (it only locks more); the vault must hold that much free quote.
    /// @notice Writer-only: earmark `amount` of the vault's existing FREE collateral as buyback funding.
    /// @dev Deliberately not permissionless. Allocation moves the writer's own capital from withdrawable to
    ///   locked, so only the writer may do it; letting anyone lock someone else's free balance would be an
    ///   interference surface (blocked withdrawals, unfunded buybacks enabled against the writer's plans).
    function allocateExitBuffer(uint256 groupId, uint256 amount) external {
        Group storage g = _get(groupId);
        require(msg.sender == g.writer, NotWriter(g.writer, msg.sender));
        _creditBuffer(g, groupId, amount);
    }

    /// @notice Permissionless: fund the buyback buffer with the CALLER'S OWN tokens, transferred into the
    ///   vault here. Third parties can add exit liquidity; they can never allocate the writer's capital.
    ///   The tokens become vault collateral like any deposit — funding is a donation, not a claim.
    function fundExitBuffer(uint256 groupId, uint256 amount) external {
        Group storage g = _get(groupId);
        SafeERC20.safeTransferFrom(IERC20(QUOTE_TOKEN), msg.sender, g.vault, amount);
        _creditBuffer(g, groupId, amount);
    }

    function _creditBuffer(Group storage g, uint256 groupId, uint256 amount) internal {
        require(amount > 0, ZeroAmount());
        require(!g.finalized, AlreadyFinalized(groupId));
        g.exitBuffer += amount;
        ITremorMakerVault(g.vault).increaseLocked(amount);
        emit ExitBufferFunded(groupId, msg.sender, amount, g.exitBuffer);
    }

    /// @notice Writer-only: unlock unspent buyback funding. The buffer is owed to nobody.
    function withdrawExitBuffer(uint256 groupId, uint256 amount) external {
        Group storage g = _get(groupId);
        require(msg.sender == g.writer, NotWriter(g.writer, msg.sender));
        require(amount > 0, ZeroAmount());
        require(amount <= g.exitBuffer, ExceedsBuffer(amount, g.exitBuffer));
        g.exitBuffer -= amount;
        ITremorMakerVault(g.vault).decreaseLocked(amount);
        emit ExitBufferWithdrawn(groupId, amount, g.exitBuffer);
    }

    // ------------------------------------------------------------------ views

    /// @notice Accumulator compatibility view: the fields it reads are feed/start/expiry/sampleInterval.
    function seriesParams(uint256 groupId) external view returns (SeriesParams memory p) {
        Group storage g = _get(groupId);
        p = SeriesParams({
            feed: g.params.feed,
            quoteToken: g.params.quoteToken,
            start: g.params.start,
            expiry: g.params.expiry,
            saleEnd: g.params.saleEnd,
            sampleInterval: g.params.sampleInterval,
            unitNotional: g.params.capPayoutPerUnit,
            capVariance: g.params.capVariance,
            anchorVariance: g.params.capVariance,
            impactPerUnit: 0,
            halfLife: 0,
            halfSpreadBps: 10,
            maxUnits: g.params.maxUnitsPerSide
        });
    }

    function groupParams(uint256 groupId) external view returns (GroupParams memory) {
        return _get(groupId).params;
    }

    struct GroupView {
        address writer;
        address vault;
        address highReceipt;
        address calmReceipt;
        uint256 highOutstanding;
        uint256 calmOutstanding;
        uint256 reserveLocked;
        uint256 exitBuffer;
        uint256 standaloneCaps; // what two separate full-cap reservations would lock right now
        bool finalized;
        uint256 finalVariance;
        uint256 xWad;
        uint256 highPpu;
        uint256 calmPpu;
    }

    function groupView(uint256 groupId) external view returns (GroupView memory v) {
        Group storage g = _get(groupId);
        v = GroupView({
            writer: g.writer,
            vault: g.vault,
            highReceipt: g.highReceipt,
            calmReceipt: g.calmReceipt,
            highOutstanding: g.highOutstanding,
            calmOutstanding: g.calmOutstanding,
            reserveLocked: g.reserveLocked,
            exitBuffer: g.exitBuffer,
            standaloneCaps: PortfolioMath.reserve(g.highOutstanding, 0, g.params.capPayoutPerUnit)
                + PortfolioMath.reserve(g.calmOutstanding, 0, g.params.capPayoutPerUnit),
            finalized: g.finalized,
            finalVariance: g.finalVariance,
            xWad: g.xWad,
            highPpu: g.highPpu,
            calmPpu: g.calmPpu
        });
    }

    function orderHashFor(uint256 groupId, POB.PMode mode) external view returns (bytes32) {
        require(mode != POB.PMode.NONE, WrongMode(mode));
        return _get(groupId).orderHashes[uint8(mode) - 1];
    }

    function orderFor(uint256 groupId, POB.PMode mode) external view returns (ISwapVM.Order memory) {
        Group storage g = _get(groupId);
        address receipt = POB.isHigh(mode) ? g.highReceipt : g.calmReceipt;
        return POB.order(
            mode, groupId, g.params.quoteToken, receipt, g.vault, address(this), g.params.saleEnd, g.params.expiry
        );
    }

    function orderRef(bytes32 orderHash) external view returns (uint256 groupId, POB.PMode mode) {
        OrderRef memory ref = _orderRef[orderHash];
        return (ref.groupId, ref.mode);
    }

    // ------------------------------------------------------------------ internals

    function _get(uint256 groupId) internal view returns (Group storage g) {
        g = _groups[groupId];
        require(g.writer != address(0), GroupNotFound(groupId));
    }

    function _auth(SwapQuery calldata query, POB.PMode mode, uint256 groupId) internal view returns (Group storage g) {
        OrderRef memory ref = _orderRef[query.orderHash];
        require(
            ref.groupId == groupId && ref.mode == mode && mode != POB.PMode.NONE,
            OrderNotRegistered(query.orderHash, groupId, mode)
        );
        g = _get(groupId);
        require(query.maker == g.vault, MakerNotVault(query.maker, g.vault));

        address receipt = POB.isHigh(mode) ? g.highReceipt : g.calmReceipt;
        (address expectedIn, address expectedOut) =
            POB.isIssue(mode) ? (g.params.quoteToken, receipt) : (receipt, g.params.quoteToken);
        require(
            query.tokenIn == expectedIn && query.tokenOut == expectedOut, WrongDirection(query.tokenIn, query.tokenOut)
        );
    }

    function _reserveAfterExit(Group storage g, bool high, uint256 units) internal view returns (uint256) {
        uint256 h = g.highOutstanding;
        uint256 c = g.calmOutstanding;
        if (high) h -= units;
        else c -= units;
        return PortfolioMath.reserve(h, c, g.params.capPayoutPerUnit);
    }

    function _validate(GroupParams calldata p, bool allowBackdated) internal view {
        require(p.feed == FEED, BadWiring());
        require(p.quoteToken == QUOTE_TOKEN, BadWiring());
        require(p.expiry > p.start, BadWindow());
        require(p.sampleInterval >= MIN_INTERVAL, BadInterval());
        require((uint256(p.expiry) - p.start) % p.sampleInterval == 0, BadInterval());
        uint256 samples = (uint256(p.expiry) - p.start) / p.sampleInterval;
        require(samples >= MIN_SAMPLES && samples <= MAX_SAMPLES, BadSampleCount(samples));
        require(p.saleEnd >= block.timestamp, BadSaleEnd());
        require(p.start <= p.saleEnd, BadSaleEnd());
        if (!allowBackdated) require(p.saleEnd <= p.expiry, BadSaleEnd());
        require(p.capVariance > 0 && p.capVariance <= MAX_CAP_VARIANCE, BadCap(p.capVariance));
        require(p.capPayoutPerUnit > 0, BadScale());
        require(p.maxUnitsPerSide > 0, BadMaxUnits());
        require(
            p.askHigh > 0 && p.askCalm > 0 && p.bidHigh <= p.askHigh && p.bidCalm <= p.askCalm
                && p.askHigh <= p.capPayoutPerUnit && p.askCalm <= p.capPayoutPerUnit,
            BadPrices()
        );
        uint256 liability = PortfolioMath.reserve(p.maxUnitsPerSide, 0, p.capPayoutPerUnit);
        require(liability > 0 && liability <= type(uint248).max, BadScale());
    }
}
