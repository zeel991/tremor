//! Contract bindings.
//!
//! The Lens bindings come from `abi/TremorLens.json` when it is present (`build.rs` sets
//! `cfg(lens_abi_json)`), so the read model cannot drift from the deployed contract without the build
//! noticing. Everything else is declared here because only the event and function signatures matter,
//! and having them written out makes the indexer's decoding auditable in one place.

#![allow(clippy::too_many_arguments, non_camel_case_types)]

use alloy::sol;

sol! {
    /// `VarianceSeriesFactory`, which is the controller: the registry, the liability ledger and the only
    /// contract the engine, the accumulator and the receipts report to.
    #[sol(rpc)]
    #[derive(Debug)]
    interface VarianceSeriesFactory {
        struct SeriesParams {
            address feed;
            address quoteToken;
            uint40  start;
            uint40  expiry;
            uint40  saleEnd;
            uint32  sampleInterval;
            uint128 unitNotional;
            uint64  capVariance;
            uint64  anchorVariance;
            uint64  impactPerUnit;
            uint32  halfLife;
            uint16  halfSpreadBps;
            uint128 maxUnits;
        }
        struct SeriesView {
            address writer;
            address vault;
            address receipt;
            uint256 outstandingUnits;
            uint256 lockedLiability;
            bool    issuanceStopped;
            bool    finalized;
            uint256 finalVariance;
            uint256 payoutPerUnit;
            int192  signedSkew;
            uint64  lastSkewTimestamp;
        }

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
        event Issued(uint256 indexed seriesId, address indexed buyer, uint256 units, uint256 premium, uint256 newOutstanding, uint256 newLocked);
        event Exited(uint256 indexed seriesId, address indexed holder, uint256 units, uint256 amountOut, uint256 newOutstanding, uint256 newLocked);
        event Settled(uint256 indexed seriesId, address indexed holder, uint256 units, uint256 amountOut, uint256 newOutstanding, uint256 newLocked);
        event Finalized(uint256 indexed seriesId, uint256 finalVariance, uint256 cappedVariance, uint256 payoutPerUnit, uint256 outstandingUnits, uint256 releasedCollateral);
        event IssuanceStopped(uint256 indexed seriesId, address indexed writer);
        event WorthlessBurned(uint256 indexed seriesId, address indexed holder, uint256 units);
        event SeriesClosed(uint256 indexed seriesId, uint256 unsoldBurned, uint256 releasedCollateral);

        function seriesCount() external view returns (uint256);
        function seriesParams(uint256 seriesId) external view returns (SeriesParams);
        function seriesView(uint256 seriesId) external view returns (SeriesView);
        function vaultOf(address writer) external view returns (address);
        function isVault(address vault) external view returns (bool);
        function predictVault(address writer) external view returns (address);
        function isClosed(uint256 seriesId) external view returns (bool);
        function ROUTER() external view returns (address);
        function AQUA() external view returns (address);
        function FEED() external view returns (address);
        function QUOTE_TOKEN() external view returns (address);
        function ENGINE() external view returns (address);
        function ACCUMULATOR() external view returns (address);
    }

    /// `TremorMakerVault`, the protected Aqua maker. Its events are the writer-side audit trail.
    #[sol(rpc)]
    #[derive(Debug)]
    interface TremorMakerVault {
        event Deposited(address indexed payer, uint256 amount, uint256 newBalance, uint256 lockedBalance);
        event FreeWithdrawn(address indexed recipient, uint256 amount, uint256 newBalance, uint256 lockedBalance);
        event LockedIncreased(uint256 amount, uint256 lockedBalance);
        event LockedDecreased(uint256 amount, uint256 lockedBalance);
        event ReceiptRegistered(address indexed receipt);
        event StrategyShipped(bytes32 indexed strategyHash);
        event StrategyDocked(bytes32 indexed strategyHash);

        function OWNER() external view returns (address);
        function lockedQuote() external view returns (uint256);
        function quoteBalance() external view returns (uint256);
        function freeQuote() external view returns (uint256);
        function aquaAllowance() external view returns (uint256);
    }

    /// `VarianceAccumulator`, the bounded permissionless checkpointer.
    #[sol(rpc)]
    #[derive(Debug)]
    interface VarianceAccumulator {
        struct Accumulator {
            uint16  processedSamples;
            uint40  processedThrough;
            uint80  lastRoundId;
            uint256 lastPriceWad;
            uint256 sumSquaredReturnsWad;
        }
        event Checkpointed(
            uint256 indexed seriesId,
            uint256 fromSample,
            uint256 toSample,
            uint40  processedThrough,
            uint80  lastRoundId,
            uint256 sumSquaredReturnsWad
        );
        function accumulator(uint256 seriesId) external view returns (Accumulator);
        function progress(uint256 seriesId) external view returns (uint256 stored, uint256 available, uint256 total);
        function isCurrent(uint256 seriesId) external view returns (bool);
        function realizedSoFar(uint256 seriesId) external view returns (uint256 variance, uint256 elapsed, uint256 processedThrough);
        function MAX_SAMPLES_PER_CALL() external view returns (uint16);
    }

    /// The unmodified official `AquaSwapVMRouter`. Only `Swapped` matters here; the order hash it carries
    /// is what maps a fill to a series and a leg.
    #[derive(Debug)]
    interface AquaSwapVMRouter {
        event Swapped(bytes32 orderHash, address maker, address taker, address tokenIn, address tokenOut, uint256 amountIn, uint256 amountOut);
    }

    #[derive(Debug)]
    interface Aqua {
        event Shipped(address maker, address app, bytes32 strategyHash, bytes strategy);
        event Docked(address maker, address app, bytes32 strategyHash);
        event Pulled(address maker, address app, bytes32 strategyHash, address token, uint256 amount);
        event Pushed(address maker, address app, bytes32 strategyHash, address token, uint256 amount);
    }

    #[sol(rpc)]
    #[derive(Debug)]
    interface AggregatorV3 {
        function latestRoundData() external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
        function getRoundData(uint80 roundId) external view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
        function phaseId() external view returns (uint16);
        function phaseAggregators(uint16 phaseId) external view returns (address);
        function decimals() external view returns (uint8);
    }

    #[sol(rpc)]
    #[derive(Debug)]
    interface VarianceReceipt {
        function totalSupply() external view returns (uint256);
        function balanceOf(address account) external view returns (uint256);
        function SERIES_ID() external view returns (uint256);
        function VAULT() external view returns (address);
    }

    /// `TremorPortfolioMarket`, the portfolio risk group controller and settlement engine.
    #[sol(rpc)]
    #[derive(Debug)]
    interface TremorPortfolioMarket {
        struct GroupParams {
            address feed;
            address quoteToken;
            uint40  start;
            uint40  expiry;
            uint40  saleEnd;
            uint32  sampleInterval;
            uint64  capVariance;
            uint128 capPayoutPerUnit;
            uint128 maxUnitsPerSide;
            uint128 askHigh;
            uint128 bidHigh;
            uint128 askCalm;
            uint128 bidCalm;
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
            uint256 standaloneCaps;
            bool    finalized;
            uint256 finalVariance;
            uint256 xWad;
            uint256 highPpu;
            uint256 calmPpu;
        }

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

        function groupCount() external view returns (uint256);
        function groupParams(uint256 groupId) external view returns (GroupParams);
        function groupView(uint256 groupId) external view returns (GroupView);
        function vaultOf(address writer) external view returns (address);
        function isVault(address vault) external view returns (bool);
        function predictVault(address writer) external view returns (address);
        function ROUTER() external view returns (address);
        function AQUA() external view returns (address);
        function FEED() external view returns (address);
        function QUOTE_TOKEN() external view returns (address);
        function ACCUMULATOR() external view returns (address);
    }
}

#[cfg(not(lens_abi_json))]
sol! {
    #[sol(rpc)]
    #[derive(Debug)]
    interface TremorLens {
        struct SeriesParams {
            address feed;
            address quoteToken;
            uint40  start;
            uint40  expiry;
            uint40  saleEnd;
            uint32  sampleInterval;
            uint128 unitNotional;
            uint64  capVariance;
            uint64  anchorVariance;
            uint64  impactPerUnit;
            uint32  halfLife;
            uint16  halfSpreadBps;
            uint128 maxUnits;
        }
        enum Status { UPCOMING, LIVE, EXPIRED_UNFINALIZED, FINALIZED, CLOSED }
        struct VaultState {
            address vault;
            address owner;
            uint256 balance;
            uint256 locked;
            uint256 free;
            uint256 aquaAllowance;
            bool allowanceSufficient;
        }
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
        struct OracleProgress {
            uint256 samplesStored;
            uint256 samplesAvailable;
            uint256 samplesTotal;
            uint256 processedThrough;
            bool checkpointsCurrent;
        }
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
            uint256 unitsAvailable;
            uint256 lockedLiability;
            uint256 finalVariance;
            uint256 payoutPerUnit;
            OracleProgress oracle;
            bool fullyCollateralized;
            VaultState vaultState;
        }
        function state(uint256 id) external view returns (SeriesState memory);
        function states(uint256 from, uint256 to) external view returns (SeriesState[] memory);
        function vaultState(address vault) external view returns (VaultState memory);
        function writerVault(address writer) external view returns (address vault, bool exists, VaultState memory vs);
        function quoteIssueExactIn(uint256 id, uint256 quoteIn) external view returns (uint256 units, uint256 premium);
        function quoteIssueExactOut(uint256 id, uint256 units) external view returns (uint256 filledUnits, uint256 premium);
        function quoteExitExactIn(uint256 id, uint256 units) external view returns (uint256 filledUnits, uint256 quoteOut);
        function quoteSettleExactIn(uint256 id, uint256 units) external view returns (uint256 filledUnits, uint256 quoteOut);
        function realizedVariance(address feed, uint40 start, uint40 end, uint32 interval) external view returns (uint256 rv, uint256 samples);
        function samplePrices(address feed, uint40 start, uint40 end, uint32 interval) external view returns (uint256[] memory prices, uint80[] memory roundIds);
        function volatilityPct(uint256 variance) external pure returns (uint256);
        function buildTakerData(address taker, bool isExactIn, bool isAToB, uint256 thresholdAmount, uint40 deadline, bool allowPartialFill) external pure returns (bytes memory);
        function lvrHedgeUnits(uint256 id, uint256 poolValueQuote, uint40 horizonSeconds) external view returns (uint256 units);
        function legDirection(uint256 id, uint8 leg) external view returns (bool isAToB);
    }
}

#[cfg(lens_abi_json)]
sol!(
    #[sol(rpc)]
    #[derive(Debug)]
    TremorLens,
    "abi/TremorLens.json"
);

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::keccak256;
    use alloy::sol_types::SolEvent;

    /// Every signature the indexer filters on, spelled out in tuple form. If a contract event changes
    /// shape, this is where it fails, rather than in a silently empty log filter.
    #[test]
    fn event_signatures_are_what_the_indexer_filters_on() {
        let series_created = "SeriesCreated(uint256,address,address,address,bytes32,bytes32,bytes32,(address,address,uint40,uint40,uint40,uint32,uint128,uint64,uint64,uint64,uint32,uint16,uint128))";
        assert_eq!(
            VarianceSeriesFactory::SeriesCreated::SIGNATURE,
            series_created
        );
        assert_eq!(
            VarianceSeriesFactory::SeriesCreated::SIGNATURE_HASH,
            keccak256(series_created.as_bytes())
        );
        assert_eq!(
            VarianceSeriesFactory::VaultCreated::SIGNATURE,
            "VaultCreated(address,address,address)"
        );
        assert_eq!(
            VarianceSeriesFactory::Issued::SIGNATURE,
            "Issued(uint256,address,uint256,uint256,uint256,uint256)"
        );
        assert_eq!(
            VarianceSeriesFactory::Exited::SIGNATURE,
            "Exited(uint256,address,uint256,uint256,uint256,uint256)"
        );
        assert_eq!(
            VarianceSeriesFactory::Settled::SIGNATURE,
            "Settled(uint256,address,uint256,uint256,uint256,uint256)"
        );
        assert_eq!(
            VarianceSeriesFactory::Finalized::SIGNATURE,
            "Finalized(uint256,uint256,uint256,uint256,uint256,uint256)"
        );
        assert_eq!(
            VarianceSeriesFactory::IssuanceStopped::SIGNATURE,
            "IssuanceStopped(uint256,address)"
        );
        assert_eq!(
            VarianceSeriesFactory::WorthlessBurned::SIGNATURE,
            "WorthlessBurned(uint256,address,uint256)"
        );
        assert_eq!(
            VarianceSeriesFactory::SeriesClosed::SIGNATURE,
            "SeriesClosed(uint256,uint256,uint256)"
        );
        assert_eq!(
            VarianceAccumulator::Checkpointed::SIGNATURE,
            "Checkpointed(uint256,uint256,uint256,uint40,uint80,uint256)"
        );
        assert_eq!(
            TremorMakerVault::Deposited::SIGNATURE,
            "Deposited(address,uint256,uint256,uint256)"
        );
        assert_eq!(
            TremorMakerVault::FreeWithdrawn::SIGNATURE,
            "FreeWithdrawn(address,uint256,uint256,uint256)"
        );
        assert_eq!(
            TremorMakerVault::LockedIncreased::SIGNATURE,
            "LockedIncreased(uint256,uint256)"
        );
        assert_eq!(
            TremorMakerVault::LockedDecreased::SIGNATURE,
            "LockedDecreased(uint256,uint256)"
        );
        assert_eq!(
            AquaSwapVMRouter::Swapped::SIGNATURE,
            "Swapped(bytes32,address,address,address,address,uint256,uint256)"
        );
        assert_eq!(
            Aqua::Shipped::SIGNATURE,
            "Shipped(address,address,bytes32,bytes)"
        );
        assert_eq!(Aqua::Docked::SIGNATURE, "Docked(address,address,bytes32)");
        assert_eq!(
            Aqua::Pulled::SIGNATURE,
            "Pulled(address,address,bytes32,address,uint256)"
        );
        assert_eq!(
            Aqua::Pushed::SIGNATURE,
            "Pushed(address,address,bytes32,address,uint256)"
        );
        let group_created = "GroupCreated(uint256,address,address,address,address,(address,address,uint40,uint40,uint40,uint32,uint64,uint128,uint128,uint128,uint128,uint128,uint128))";
        assert_eq!(
            TremorPortfolioMarket::GroupCreated::SIGNATURE,
            group_created
        );
        assert_eq!(
            TremorPortfolioMarket::PortfolioIssued::SIGNATURE,
            "PortfolioIssued(uint256,address,bool,uint256,uint256,uint256,uint256,uint256)"
        );
        assert_eq!(
            TremorPortfolioMarket::PortfolioExited::SIGNATURE,
            "PortfolioExited(uint256,address,bool,uint256,uint256,uint256,uint256,uint256)"
        );
        assert_eq!(
            TremorPortfolioMarket::PortfolioSettled::SIGNATURE,
            "PortfolioSettled(uint256,address,bool,uint256,uint256,uint256)"
        );
        assert_eq!(
            TremorPortfolioMarket::GroupFinalized::SIGNATURE,
            "GroupFinalized(uint256,uint256,uint256,uint256,uint256,uint256)"
        );
        assert_eq!(
            TremorPortfolioMarket::ExitBufferFunded::SIGNATURE,
            "ExitBufferFunded(uint256,address,uint256,uint256)"
        );
        assert_eq!(
            TremorPortfolioMarket::ExitBufferWithdrawn::SIGNATURE,
            "ExitBufferWithdrawn(uint256,uint256,uint256)"
        );
        assert_eq!(
            TremorPortfolioMarket::WorthlessBurned::SIGNATURE,
            "WorthlessBurned(uint256,address,bool,uint256)"
        );
    }

    #[test]
    fn portfolio_abi_log_decoding_round_trip() {
        use alloy::primitives::Address;
        // Test GroupFinalized decode
        let gf = TremorPortfolioMarket::GroupFinalized {
            groupId: alloy::primitives::U256::from(1),
            finalVariance: alloy::primitives::U256::from(105488314168210179u128),
            xWad: alloy::primitives::U256::from(105488314168210179u128),
            highPayoutPerUnit: alloy::primitives::U256::from(105488),
            calmPayoutPerUnit: alloy::primitives::U256::from(894512),
            releasedCollateral: alloy::primitives::U256::ZERO,
        };
        let log = gf.encode_log_data();
        let decoded =
            TremorPortfolioMarket::GroupFinalized::decode_raw_log(log.topics(), &log.data).unwrap();
        assert_eq!(decoded.groupId, alloy::primitives::U256::from(1));
        assert_eq!(
            decoded.finalVariance,
            alloy::primitives::U256::from(105488314168210179u128)
        );
        assert_eq!(
            decoded.highPayoutPerUnit,
            alloy::primitives::U256::from(105488)
        );
        assert_eq!(
            decoded.calmPayoutPerUnit,
            alloy::primitives::U256::from(894512)
        );

        // Test PortfolioIssued decode
        let pi = TremorPortfolioMarket::PortfolioIssued {
            groupId: alloy::primitives::U256::from(1),
            buyer: Address::repeat_byte(0x01),
            high: true,
            units: alloy::primitives::U256::from(100),
            premium: alloy::primitives::U256::from(30),
            highOutstanding: alloy::primitives::U256::from(100),
            calmOutstanding: alloy::primitives::U256::ZERO,
            reserveLocked: alloy::primitives::U256::from(100),
        };
        let log_pi = pi.encode_log_data();
        let decoded_pi =
            TremorPortfolioMarket::PortfolioIssued::decode_raw_log(log_pi.topics(), &log_pi.data)
                .unwrap();
        assert_eq!(decoded_pi.groupId, alloy::primitives::U256::from(1));
        assert!(decoded_pi.high);
        assert_eq!(decoded_pi.units, alloy::primitives::U256::from(100));
        assert_eq!(decoded_pi.premium, alloy::primitives::U256::from(30));

        // Test ExitBufferFunded decode
        let bf = TremorPortfolioMarket::ExitBufferFunded {
            groupId: alloy::primitives::U256::from(1),
            payer: Address::repeat_byte(0x02),
            amount: alloy::primitives::U256::from(5000000),
            newBuffer: alloy::primitives::U256::from(5000000),
        };
        let log_bf = bf.encode_log_data();
        let decoded_bf =
            TremorPortfolioMarket::ExitBufferFunded::decode_raw_log(log_bf.topics(), &log_bf.data)
                .unwrap();
        assert_eq!(decoded_bf.amount, alloy::primitives::U256::from(5000000));
        assert_eq!(decoded_bf.newBuffer, alloy::primitives::U256::from(5000000));
    }
}
