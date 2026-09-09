// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISwapVM} from "swap-vm/interfaces/ISwapVM.sol";

import {TremorTestBase} from "./base/TremorTestBase.sol";
import {SeriesParams, Leg} from "../src/libs/SeriesParams.sol";
import {VarianceSeriesFactory} from "../src/VarianceSeriesFactory.sol";
import {TremorMakerVault} from "../src/TremorMakerVault.sol";
import {VarianceReceipt} from "../src/tokens/VarianceReceipt.sol";

/// @notice Series creation: parameter bounds one at a time, vault and writer authorization, and the exact
///   shape of the three strategies the vault ships.
contract SeriesCreationTest is TremorTestBase {
    function test_creation_mintsInventoryOnlyToTheVault() public {
        SeriesParams memory p = forwardParams();
        (, VarianceReceipt receipt, TremorMakerVault vault) = openMarket(p);
        assertEq(receipt.totalSupply(), p.maxUnits);
        assertEq(receipt.balanceOf(address(vault)), p.maxUnits);
        assertEq(receipt.balanceOf(writer), 0, "the writer personally holds nothing");
        assertEq(receipt.VAULT(), address(vault));
        assertEq(receipt.CONTROLLER(), address(factory));
        assertEq(receipt.ROUTER(), address(router));
    }

    function test_creation_locksNoCollateral() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,, TremorMakerVault vault) = openMarket(p);
        assertEq(vault.lockedQuote(), 0);
        assertEq(factory.seriesView(id).lockedLiability, 0);
        assertEq(vault.freeQuote(), maxLiabilityOf(p), "the writer can still withdraw everything");
    }

    function test_creation_producesThreeDistinctRegisteredHashes() public {
        SeriesParams memory p = forwardParams();
        (uint256 id,,) = openMarket(p);
        (,,, bytes32 issueHash, bytes32 exitHash, bytes32 settleHash,) = factory.series(id);
        assertTrue(issueHash != exitHash && exitHash != settleHash && issueHash != settleHash);

        (uint256 s1, Leg l1) = factory.orderLeg(issueHash);
        (uint256 s2, Leg l2) = factory.orderLeg(exitHash);
        (uint256 s3, Leg l3) = factory.orderLeg(settleHash);
        assertEq(s1, id);
        assertEq(s2, id);
        assertEq(s3, id);
        assertEq(uint8(l1), uint8(Leg.ISSUE));
        assertEq(uint8(l2), uint8(Leg.EXIT));
        assertEq(uint8(l3), uint8(Leg.SETTLE));

        (, Leg unknown) = factory.orderLeg(keccak256("not an order"));
        assertEq(uint8(unknown), uint8(Leg.NONE));
    }

    function test_creation_shipsTheExpectedAquaBalances() public {
        SeriesParams memory p = forwardParams();
        (uint256 id, VarianceReceipt receipt, TremorMakerVault vault) = openMarket(p);
        (,,, bytes32 issueHash, bytes32 exitHash, bytes32 settleHash,) = factory.series(id);
        uint256 liability = maxLiabilityOf(p);

        (uint248 issueReceipt,) = aqua.rawBalances(address(vault), address(router), issueHash, address(receipt));
        (uint248 issueQuote,) = aqua.rawBalances(address(vault), address(router), issueHash, address(usdc));
        assertEq(issueReceipt, p.maxUnits, "ISSUE ships the whole inventory");
        assertEq(issueQuote, 0);

        (uint248 exitQuote,) = aqua.rawBalances(address(vault), address(router), exitHash, address(usdc));
        (uint248 exitReceipt,) = aqua.rawBalances(address(vault), address(router), exitHash, address(receipt));
        assertEq(exitQuote, liability, "EXIT ships the maximum liability");
        assertEq(exitReceipt, 0);

        (uint248 settleQuote,) = aqua.rawBalances(address(vault), address(router), settleHash, address(usdc));
        assertEq(settleQuote, liability, "SETTLE ships the same maximum liability");

        // The two burn legs are each shipped for the full liability, yet only one reserve exists: shipping
        // is Aqua accounting, not a transfer.
        assertEq(vault.quoteBalance(), liability, "one reserve backs both burn legs");
    }

    function test_orders_makersAndDirectionsAreCorrect() public {
        SeriesParams memory p = forwardParams();
        (uint256 id, VarianceReceipt receipt, TremorMakerVault vault) = openMarket(p);
        (ISwapVM.Order memory issue, ISwapVM.Order memory exit, ISwapVM.Order memory settle) = programs.orders(id);
        assertEq(issue.maker, address(vault));
        assertEq(exit.maker, address(vault));
        assertEq(settle.maker, address(vault));

        // ISSUE takes the quote token in; the two burn legs take receipts in.
        assertEq(lens.legDirection(id, Leg.ISSUE), address(usdc) < address(receipt));
        assertEq(lens.legDirection(id, Leg.EXIT), address(receipt) < address(usdc));
        assertEq(lens.legDirection(id, Leg.SETTLE), address(receipt) < address(usdc));

        // Every hash the registry holds is the hash the official router computes.
        (,,, bytes32 issueHash, bytes32 exitHash, bytes32 settleHash,) = factory.series(id);
        assertEq(router.hash(issue), issueHash);
        assertEq(router.hash(exit), exitHash);
        assertEq(router.hash(settle), settleHash);
    }

    function test_creation_rejectsAnUnregisteredVault() public {
        SeriesParams memory p = forwardParams();
        address rogue =
            address(new TremorMakerVault(writer, address(usdc), address(aqua), address(router), address(factory)));
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.UnknownVault.selector, rogue));
        factory.createSeries(rogue, p);
    }

    function test_creation_rejectsTheWrongWriter() public {
        SeriesParams memory p = forwardParams();
        TremorMakerVault vault = writerVaultFor(p);
        vm.prank(buyer1);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.NotWriter.selector, writer, buyer1));
        factory.createSeries(address(vault), p);
    }

    function test_creation_rejectsAForeignFeedOrQuoteToken() public {
        SeriesParams memory p = forwardParams();
        TremorMakerVault vault = writerVaultFor(p);
        p.feed = address(0xFEED);
        vm.prank(writer);
        vm.expectRevert(VarianceSeriesFactory.BadFeed.selector);
        factory.createSeries(address(vault), p);

        p = forwardParams();
        p.quoteToken = address(0xC0FFEE);
        vm.prank(writer);
        vm.expectRevert(VarianceSeriesFactory.BadQuoteToken.selector);
        factory.createSeries(address(vault), p);
    }

    function test_parameterBounds_oneAtATime() public {
        SeriesParams memory base = forwardParams();
        TremorMakerVault vault = writerVaultFor(base);

        _expectBad(
            vault,
            _with(base, "expiry", uint256(base.start)),
            abi.encodeWithSelector(VarianceSeriesFactory.BadWindow.selector, base.start, base.start)
        );
        _expectBad(
            vault,
            _with(base, "sampleInterval", 299),
            abi.encodeWithSelector(VarianceSeriesFactory.BadInterval.selector, uint32(299))
        );
        _expectBad(
            vault,
            _with(base, "sampleInterval", 7000),
            abi.encodeWithSelector(VarianceSeriesFactory.BadInterval.selector, uint32(7000))
        );
        _expectBad(vault, _with(base, "unitNotional", 0), VarianceSeriesFactory.BadNotional.selector);
        _expectBad(
            vault,
            _with(base, "capVariance", 0),
            abi.encodeWithSelector(VarianceSeriesFactory.BadCap.selector, uint64(0))
        );
        _expectBad(
            vault,
            _with(base, "capVariance", 4e18 + 1),
            abi.encodeWithSelector(VarianceSeriesFactory.BadCap.selector, uint64(4e18 + 1))
        );
        _expectBad(
            vault,
            _with(base, "anchorVariance", 0),
            abi.encodeWithSelector(VarianceSeriesFactory.BadAnchor.selector, uint64(0))
        );
        _expectBad(
            vault,
            _with(base, "anchorVariance", uint256(base.capVariance) + 1),
            abi.encodeWithSelector(VarianceSeriesFactory.BadAnchor.selector, uint64(uint256(base.capVariance) + 1))
        );
        _expectBad(
            vault,
            _with(base, "impactPerUnit", uint256(base.capVariance) + 1),
            abi.encodeWithSelector(VarianceSeriesFactory.BadImpact.selector, uint64(uint256(base.capVariance) + 1))
        );
        _expectBad(
            vault,
            _with(base, "halfSpreadBps", 9),
            abi.encodeWithSelector(VarianceSeriesFactory.BadSpread.selector, uint16(9))
        );
        _expectBad(
            vault,
            _with(base, "halfSpreadBps", 2001),
            abi.encodeWithSelector(VarianceSeriesFactory.BadSpread.selector, uint16(2001))
        );
        _expectBad(
            vault,
            _with(base, "halfLife", 299),
            abi.encodeWithSelector(VarianceSeriesFactory.BadHalfLife.selector, uint32(299))
        );
        _expectBad(
            vault,
            _with(base, "halfLife", uint256(30 days) + 1),
            abi.encodeWithSelector(VarianceSeriesFactory.BadHalfLife.selector, uint32(uint256(30 days) + 1))
        );
        _expectBad(vault, _with(base, "maxUnits", 0), VarianceSeriesFactory.BadMaxUnits.selector);

        // A zero half-life is explicitly allowed: it means the inventory skew never decays.
        SeriesParams memory noDecay = _with(base, "halfLife", 0);
        vm.prank(writer);
        factory.createSeries(address(vault), noDecay);
    }

    function test_sampleCountBounds() public {
        SeriesParams memory p = forwardParams();
        TremorMakerVault vault = writerVaultFor(p);

        // one sample is too few to produce a return
        p.sampleInterval = uint32(uint256(p.expiry) - p.start);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.BadSampleCount.selector, uint256(1)));
        factory.createSeries(address(vault), p);

        // 257 samples exceeds the ceiling
        p = forwardParams();
        p.sampleInterval = 300;
        p.expiry = uint40(uint256(p.start) + 300 * 257);
        p.saleEnd = p.expiry;
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.BadSampleCount.selector, uint256(257)));
        factory.createSeries(address(vault), p);
    }

    function test_saleEndBounds() public {
        SeriesParams memory p = forwardParams();
        TremorMakerVault vault = writerVaultFor(p);

        // A sale that has already closed cannot open.
        p.saleEnd = uint40(block.timestamp - 1);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.BadSaleEnd.selector, p.saleEnd));
        factory.createSeries(address(vault), p);

        // A production sale cannot outlive the window.
        p = forwardParams();
        p.saleEnd = uint40(uint256(p.expiry) + 1);
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.BadSaleEnd.selector, p.saleEnd));
        factory.createSeries(address(vault), p);
    }

    function test_backdatedCreation_isLocalOnly() public {
        SeriesParams memory p = backdatedParams();
        TremorMakerVault vault = writerVaultFor(p);

        // The production path refuses a sale that outlives the window, which is what a back-dated series is.
        vm.prank(writer);
        vm.expectRevert(abi.encodeWithSelector(VarianceSeriesFactory.BadSaleEnd.selector, p.saleEnd));
        factory.createSeries(address(vault), p);

        vm.chainId(8453);
        vm.prank(writer);
        vm.expectRevert(VarianceSeriesFactory.DemoOnly.selector);
        factory.createBackdatedDemoSeries(address(vault), p);

        vm.chainId(31_337);
        vm.prank(writer);
        (uint256 id,) = factory.createBackdatedDemoSeries(address(vault), p);
        assertEq(id, 1);
    }

    function test_multipleSeriesShareOneVaultAndAccumulateSeparately() public {
        SeriesParams memory p = forwardParams();
        TremorMakerVault vault = createVault(writer);
        fundVault(vault, writer, 2 * maxLiabilityOf(p));

        (uint256 id1,) = createSeries(vault, p);
        SeriesParams memory q = forwardParams();
        q.anchorVariance = 0.3e18;
        (uint256 id2,) = createSeries(vault, q);
        assertTrue(id1 != id2);

        buyUnits(buyer1, id1, 5e18);
        uint256 lockedAfterFirst = vault.lockedQuote();
        assertEq(lockedAfterFirst, expectedMaxLiability(5e18, p.unitNotional, p.capVariance));

        buyUnits(buyer2, id2, 3e18);
        assertEq(
            vault.lockedQuote(),
            lockedAfterFirst + expectedMaxLiability(3e18, q.unitNotional, q.capVariance),
            "vault-level lock is the sum of the series locks"
        );
        assertEq(factory.seriesView(id1).lockedLiability, expectedMaxLiability(5e18, p.unitNotional, p.capVariance));
        assertEq(factory.seriesView(id2).lockedLiability, expectedMaxLiability(3e18, q.unitNotional, q.capVariance));
    }

    // ------------------------------------------------------------------ helpers

    function _expectBad(TremorMakerVault vault, SeriesParams memory p, bytes memory err) internal {
        vm.prank(writer);
        vm.expectRevert(err);
        factory.createSeries(address(vault), p);
    }

    function _expectBad(TremorMakerVault vault, SeriesParams memory p, bytes4 err) internal {
        vm.prank(writer);
        vm.expectRevert(err);
        factory.createSeries(address(vault), p);
    }

    /// @dev One-field override so each bound is exercised in isolation from a known-good baseline.
    /// @dev The struct is rebuilt field by field on purpose: `memory` struct assignment in Solidity aliases
    ///   rather than copies, so `p = base` would let each override leak into the next case.
    function _with(SeriesParams memory base, string memory field, uint256 value)
        internal
        pure
        returns (SeriesParams memory p)
    {
        p = SeriesParams({
            feed: base.feed,
            quoteToken: base.quoteToken,
            start: base.start,
            expiry: base.expiry,
            saleEnd: base.saleEnd,
            sampleInterval: base.sampleInterval,
            unitNotional: base.unitNotional,
            capVariance: base.capVariance,
            anchorVariance: base.anchorVariance,
            impactPerUnit: base.impactPerUnit,
            halfLife: base.halfLife,
            halfSpreadBps: base.halfSpreadBps,
            maxUnits: base.maxUnits
        });
        bytes32 f = keccak256(bytes(field));
        if (f == keccak256("expiry")) p.expiry = uint40(value);
        else if (f == keccak256("sampleInterval")) p.sampleInterval = uint32(value);
        else if (f == keccak256("unitNotional")) p.unitNotional = uint128(value);
        else if (f == keccak256("capVariance")) p.capVariance = uint64(value);
        else if (f == keccak256("anchorVariance")) p.anchorVariance = uint64(value);
        else if (f == keccak256("impactPerUnit")) p.impactPerUnit = uint64(value);
        else if (f == keccak256("halfSpreadBps")) p.halfSpreadBps = uint16(value);
        else if (f == keccak256("halfLife")) p.halfLife = uint32(value);
        else if (f == keccak256("maxUnits")) p.maxUnits = uint128(value);
        else revert("unknown field");
    }
}
