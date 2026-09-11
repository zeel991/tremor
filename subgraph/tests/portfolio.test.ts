import {
  assert,
  describe,
  test,
  clearStore,
  beforeEach,
  afterEach,
  newTypedMockEventWithParams,
} from "matchstick-as/assembly/index";
import { Address, BigInt, Bytes, ethereum } from "@graphprotocol/graph-ts";
import {
  handleGroupCreated,
  handlePortfolioIssued,
  handlePortfolioExited,
  handlePortfolioSettled,
  handleGroupFinalized,
  handleExitBufferFunded,
  handleExitBufferWithdrawn,
  handleWorthlessBurned,
} from "../src/portfolio";
import {
  GroupCreated,
  PortfolioIssued,
  PortfolioExited,
  PortfolioSettled,
  GroupFinalized,
  ExitBufferFunded,
  ExitBufferWithdrawn,
  WorthlessBurned,
} from "../generated/PortfolioMarket/PortfolioMarket";

function createGroupCreatedEvent(
  groupId: BigInt,
  writer: Address,
  vault: Address,
  highReceipt: Address,
  calmReceipt: Address
): GroupCreated {
  let params: Array<ethereum.EventParam> = [
    new ethereum.EventParam("groupId", ethereum.Value.fromUnsignedBigInt(groupId)),
    new ethereum.EventParam("writer", ethereum.Value.fromAddress(writer)),
    new ethereum.EventParam("vault", ethereum.Value.fromAddress(vault)),
    new ethereum.EventParam("highReceipt", ethereum.Value.fromAddress(highReceipt)),
    new ethereum.EventParam("calmReceipt", ethereum.Value.fromAddress(calmReceipt)),
    new ethereum.EventParam(
      "params",
      ethereum.Value.fromTuple(
        changetype<ethereum.Tuple>([
          ethereum.Value.fromAddress(Address.fromString("0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70")),
          ethereum.Value.fromAddress(Address.fromString("0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913")),
          ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(1700000000)),
          ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(1700604800)),
          ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(1700604800)),
          ethereum.Value.fromUnsignedBigInt(BigInt.fromI64(7200)),
          ethereum.Value.fromUnsignedBigInt(BigInt.fromString("1000000000000000000")),
          ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(1000000)), // S = 1e6 ($1)
          ethereum.Value.fromUnsignedBigInt(BigInt.fromString("1000000000000000000000")), // 1000 max
          ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(300000)), // askHigh 30c
          ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(250000)), // bidHigh 25c
          ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(750000)), // askCalm 75c
          ethereum.Value.fromUnsignedBigInt(BigInt.fromI32(700000)), // bidCalm 70c
        ])
      )
    ),
  ];
  return newTypedMockEventWithParams<GroupCreated>(params);
}

function createPortfolioIssuedEvent(
  groupId: BigInt,
  buyer: Address,
  high: boolean,
  units: BigInt,
  premium: BigInt,
  highOutstanding: BigInt,
  calmOutstanding: BigInt,
  reserveLocked: BigInt
): PortfolioIssued {
  let params: Array<ethereum.EventParam> = [
    new ethereum.EventParam("groupId", ethereum.Value.fromUnsignedBigInt(groupId)),
    new ethereum.EventParam("buyer", ethereum.Value.fromAddress(buyer)),
    new ethereum.EventParam("high", ethereum.Value.fromBoolean(high)),
    new ethereum.EventParam("units", ethereum.Value.fromUnsignedBigInt(units)),
    new ethereum.EventParam("premium", ethereum.Value.fromUnsignedBigInt(premium)),
    new ethereum.EventParam("highOutstanding", ethereum.Value.fromUnsignedBigInt(highOutstanding)),
    new ethereum.EventParam("calmOutstanding", ethereum.Value.fromUnsignedBigInt(calmOutstanding)),
    new ethereum.EventParam("reserveLocked", ethereum.Value.fromUnsignedBigInt(reserveLocked)),
  ];
  return newTypedMockEventWithParams<PortfolioIssued>(params);
}

function createGroupFinalizedEvent(
  groupId: BigInt,
  finalVariance: BigInt,
  xWad: BigInt,
  highPpu: BigInt,
  calmPpu: BigInt,
  releasedCollateral: BigInt
): GroupFinalized {
  let params: Array<ethereum.EventParam> = [
    new ethereum.EventParam("groupId", ethereum.Value.fromUnsignedBigInt(groupId)),
    new ethereum.EventParam("finalVariance", ethereum.Value.fromUnsignedBigInt(finalVariance)),
    new ethereum.EventParam("xWad", ethereum.Value.fromUnsignedBigInt(xWad)),
    new ethereum.EventParam("highPayoutPerUnit", ethereum.Value.fromUnsignedBigInt(highPpu)),
    new ethereum.EventParam("calmPayoutPerUnit", ethereum.Value.fromUnsignedBigInt(calmPpu)),
    new ethereum.EventParam("releasedCollateral", ethereum.Value.fromUnsignedBigInt(releasedCollateral)),
  ];
  return newTypedMockEventWithParams<GroupFinalized>(params);
}

function createPortfolioExitedEvent(
  groupId: BigInt,
  holder: Address,
  high: boolean,
  units: BigInt,
  amountOut: BigInt,
  reserveReleased: BigInt,
  bufferDrawn: BigInt,
  reserveLocked: BigInt
): PortfolioExited {
  let params: Array<ethereum.EventParam> = [
    new ethereum.EventParam("groupId", ethereum.Value.fromUnsignedBigInt(groupId)),
    new ethereum.EventParam("holder", ethereum.Value.fromAddress(holder)),
    new ethereum.EventParam("high", ethereum.Value.fromBoolean(high)),
    new ethereum.EventParam("units", ethereum.Value.fromUnsignedBigInt(units)),
    new ethereum.EventParam("amountOut", ethereum.Value.fromUnsignedBigInt(amountOut)),
    new ethereum.EventParam("reserveReleased", ethereum.Value.fromUnsignedBigInt(reserveReleased)),
    new ethereum.EventParam("bufferDrawn", ethereum.Value.fromUnsignedBigInt(bufferDrawn)),
    new ethereum.EventParam("reserveLocked", ethereum.Value.fromUnsignedBigInt(reserveLocked)),
  ];
  return newTypedMockEventWithParams<PortfolioExited>(params);
}

function createExitBufferFundedEvent(
  groupId: BigInt,
  payer: Address,
  amount: BigInt,
  newBuffer: BigInt
): ExitBufferFunded {
  let params: Array<ethereum.EventParam> = [
    new ethereum.EventParam("groupId", ethereum.Value.fromUnsignedBigInt(groupId)),
    new ethereum.EventParam("payer", ethereum.Value.fromAddress(payer)),
    new ethereum.EventParam("amount", ethereum.Value.fromUnsignedBigInt(amount)),
    new ethereum.EventParam("newBuffer", ethereum.Value.fromUnsignedBigInt(newBuffer)),
  ];
  return newTypedMockEventWithParams<ExitBufferFunded>(params);
}

function createPortfolioSettledEvent(
  groupId: BigInt,
  holder: Address,
  high: boolean,
  units: BigInt,
  amountOut: BigInt,
  reserveLocked: BigInt
): PortfolioSettled {
  let params: Array<ethereum.EventParam> = [
    new ethereum.EventParam("groupId", ethereum.Value.fromUnsignedBigInt(groupId)),
    new ethereum.EventParam("holder", ethereum.Value.fromAddress(holder)),
    new ethereum.EventParam("high", ethereum.Value.fromBoolean(high)),
    new ethereum.EventParam("units", ethereum.Value.fromUnsignedBigInt(units)),
    new ethereum.EventParam("amountOut", ethereum.Value.fromUnsignedBigInt(amountOut)),
    new ethereum.EventParam("reserveLocked", ethereum.Value.fromUnsignedBigInt(reserveLocked)),
  ];
  return newTypedMockEventWithParams<PortfolioSettled>(params);
}

function createWorthlessBurnedEvent(
  groupId: BigInt,
  holder: Address,
  high: boolean,
  units: BigInt
): WorthlessBurned {
  let params: Array<ethereum.EventParam> = [
    new ethereum.EventParam("groupId", ethereum.Value.fromUnsignedBigInt(groupId)),
    new ethereum.EventParam("holder", ethereum.Value.fromAddress(holder)),
    new ethereum.EventParam("high", ethereum.Value.fromBoolean(high)),
    new ethereum.EventParam("units", ethereum.Value.fromUnsignedBigInt(units)),
  ];
  return newTypedMockEventWithParams<WorthlessBurned>(params);
}

describe("Portfolio Subgraph Accounting", () => {
  beforeEach(() => {
    clearStore();
  });

  afterEach(() => {
    clearStore();
  });

  test("Balanced finalization with zero collateral released but nonzero reserve retained", () => {
    let writer = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    let vault = Address.fromString("0x1111111111111111111111111111111111111111");
    let high = Address.fromString("0x2222222222222222222222222222222222222222");
    let calm = Address.fromString("0x3333333333333333333333333333333333333333");
    let groupId = BigInt.fromI32(1);

    handleGroupCreated(createGroupCreatedEvent(groupId, writer, vault, high, calm));

    // 100 HIGH and 100 CALM sold. Required reserve = max(100, 100) * $1 = $100 (100,000,000)
    let units = BigInt.fromString("100000000000000000000"); // 100e18
    let reserve = BigInt.fromI32(100000000); // 100e6
    handlePortfolioIssued(createPortfolioIssuedEvent(groupId, writer, true, units, BigInt.fromI32(30000000), units, BigInt.zero(), reserve));
    handlePortfolioIssued(createPortfolioIssuedEvent(groupId, writer, false, units, BigInt.fromI32(75000000), units, units, reserve));

    // Balanced finalization: final variance = 0.5e18, hp = 0.5e6, cp = 0.5e6
    // High liability = floor(100e18 * 0.5e6 / 1e18) = 50e6
    // Calm liability = floor(100e18 * 0.5e6 / 1e18) = 50e6
    // Total liability = 100e6. Released collateral = 0!
    let hp = BigInt.fromI32(500000);
    let cp = BigInt.fromI32(500000);
    let released = BigInt.zero();
    handleGroupFinalized(createGroupFinalizedEvent(groupId, BigInt.fromString("500000000000000000"), BigInt.fromString("500000000000000000"), hp, cp, released));

    // Assert that reserveLocked remains exactly 100e6 (not set to released 0!)
    assert.fieldEquals("PortfolioGroup", "1", "reserveLocked", "100000000");
    assert.fieldEquals("PortfolioGroup", "1", "exitBuffer", "0");
    assert.fieldEquals("PortfolioGroup", "1", "finalized", "true");
  });

  test("Asymmetric positions with funded buffer, rounding, and released collateral", () => {
    let writer = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    let vault = Address.fromString("0x1111111111111111111111111111111111111111");
    let high = Address.fromString("0x2222222222222222222222222222222222222222");
    let calm = Address.fromString("0x3333333333333333333333333333333333333333");
    let groupId = BigInt.fromI32(2);

    handleGroupCreated(createGroupCreatedEvent(groupId, writer, vault, high, calm));

    // 80 HIGH, 100 CALM, $5 buffer funded
    let u80 = BigInt.fromString("80000000000000000000");
    let u100 = BigInt.fromString("100000000000000000000");
    let reserve = BigInt.fromI32(100000000); // max(80, 100) * 1 = 100
    handlePortfolioIssued(createPortfolioIssuedEvent(groupId, writer, true, u80, BigInt.fromI32(24000000), u80, BigInt.zero(), reserve));
    handlePortfolioIssued(createPortfolioIssuedEvent(groupId, writer, false, u100, BigInt.fromI32(75000000), u80, u100, reserve));
    handleExitBufferFunded(createExitBufferFundedEvent(groupId, writer, BigInt.fromI32(5000000), BigInt.fromI32(5000000)));

    assert.fieldEquals("PortfolioGroup", "2", "exitBuffer", "5000000");

    // Finalize with hp = 0.2e6 (200000), cp = 0.8e6 (800000)
    // High liability = floor(80e18 * 200000 / 1e18) = 16,000,000 ($16)
    // Calm liability = floor(100e18 * 800000 / 1e18) = 80,000,000 ($80)
    // newLocked = 16e6 + 80e6 = 96,000,000 ($96)
    // released = reserve (100) + buffer (5) - newLocked (96) = 9,000,000 ($9)
    let hp = BigInt.fromI32(200000);
    let cp = BigInt.fromI32(800000);
    let released = BigInt.fromI32(9000000);
    handleGroupFinalized(createGroupFinalizedEvent(groupId, BigInt.fromString("200000000000000000"), BigInt.fromString("200000000000000000"), hp, cp, released));

    assert.fieldEquals("PortfolioGroup", "2", "reserveLocked", "96000000");
    assert.fieldEquals("PortfolioGroup", "2", "exitBuffer", "0");
  });

  test("Redemption and Worthless Burn decrements outstanding sides correctly", () => {
    let writer = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    let vault = Address.fromString("0x1111111111111111111111111111111111111111");
    let high = Address.fromString("0x2222222222222222222222222222222222222222");
    let calm = Address.fromString("0x3333333333333333333333333333333333333333");
    let groupId = BigInt.fromI32(3);

    handleGroupCreated(createGroupCreatedEvent(groupId, writer, vault, high, calm));

    let u50 = BigInt.fromString("50000000000000000000");
    handlePortfolioIssued(createPortfolioIssuedEvent(groupId, writer, true, u50, BigInt.fromI32(15000000), u50, BigInt.zero(), BigInt.fromI32(50000000)));
    handlePortfolioIssued(createPortfolioIssuedEvent(groupId, writer, false, u50, BigInt.fromI32(35000000), u50, u50, BigInt.fromI32(50000000)));

    // Finalize with HIGH worthless (hp = 0, cp = 1e6)
    handleGroupFinalized(createGroupFinalizedEvent(groupId, BigInt.zero(), BigInt.zero(), BigInt.zero(), BigInt.fromI32(1000000), BigInt.zero()));

    // Redeem CALM side (50 units)
    handlePortfolioSettled(createPortfolioSettledEvent(groupId, writer, false, u50, BigInt.fromI32(50000000), BigInt.zero()));
    assert.fieldEquals("PortfolioGroup", "3", "calmOutstanding", "0");
    assert.fieldEquals("PortfolioGroup", "3", "highOutstanding", "50000000000000000000");

    // Worthless burn HIGH side (50 units)
    handleWorthlessBurned(createWorthlessBurnedEvent(groupId, writer, true, u50));
    assert.fieldEquals("PortfolioGroup", "3", "highOutstanding", "0");
  });

  test("Fractional-unit positions with nonzero division remainders floor correctly", () => {
    let writer = Address.fromString("0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266");
    let vault = Address.fromString("0x1111111111111111111111111111111111111111");
    let high = Address.fromString("0x2222222222222222222222222222222222222222");
    let calm = Address.fromString("0x3333333333333333333333333333333333333333");
    let groupId = BigInt.fromI32(4);

    handleGroupCreated(createGroupCreatedEvent(groupId, writer, vault, high, calm));

    // Prime fractional units:
    // h = 33_333_333_333_333_333_337 (~33.333 units)
    // c = 17_777_777_777_777_777_779 (~17.777 units)
    let hUnits = BigInt.fromString("33333333333333333337");
    let cUnits = BigInt.fromString("17777777777777777779");

    // Reserve = ceil(max(h, c) * S / 1e18) = ceil(33333333333333333337 * 1000000 / 1e18)
    // 33333333333333333337 * 1000000 = 33333333333333333337000000
    // Remainder modulo 1e18 is 337000000 != 0
    // Quotient = 33333333, ceil = 33333334 ($33.333334)
    let reserve = BigInt.fromString("33333334");

    handlePortfolioIssued(createPortfolioIssuedEvent(groupId, writer, true, hUnits, BigInt.fromI32(10000000), hUnits, BigInt.zero(), reserve));
    handlePortfolioIssued(createPortfolioIssuedEvent(groupId, writer, false, cUnits, BigInt.fromI32(13333333), hUnits, cUnits, reserve));

    assert.fieldEquals("PortfolioGroup", "4", "highOutstanding", "33333333333333333337");
    assert.fieldEquals("PortfolioGroup", "4", "calmOutstanding", "17777777777777777779");
    assert.fieldEquals("PortfolioGroup", "4", "reserveLocked", "33333334");

    // Finalize with fractional payouts with nonzero remainders:
    // hp = 333,333 ($0.333333), cp = 666,667 ($0.666667) (hp + cp = 1e6)
    // High product: 33333333333333333337 * 333333 = 11111100000000001222221
    // Remainder = 1222221 != 0
    // floor(high liability) = 11,111,100
    // Calm product: 17777777777777777779 * 666667 = 11851857777777777778592593
    // Remainder = 777777777778592593 != 0
    // floor(calm liability) = 11,851,857
    // newLocked = 11,111,100 + 11,851,857 = 22,962,957 ($22.962957)
    // released = reserve (33,333,334) + buffer (0) - newLocked (22,962,957) = 10,370,377 ($10.370377)
    let hp = BigInt.fromI32(333333);
    let cp = BigInt.fromI32(666667);
    let released = BigInt.fromI32(10370377);

    handleGroupFinalized(createGroupFinalizedEvent(
      groupId,
      BigInt.fromString("333333000000000000"),
      BigInt.fromString("333333000000000000"),
      hp,
      cp,
      released
    ));

    // Assert that reserveLocked matches the exact integer floor sum
    assert.fieldEquals("PortfolioGroup", "4", "reserveLocked", "22962957");
    assert.fieldEquals("PortfolioGroup", "4", "exitBuffer", "0");
    assert.fieldEquals("PortfolioGroup", "4", "finalized", "true");

    // Settle high side:
    // Settle payout for hUnits = floor(33333333333333333337 * 333333 / 1e18) = 11111100
    // Remaining locked: 22962957 - 11111100 = 11851857
    handlePortfolioSettled(createPortfolioSettledEvent(groupId, writer, true, hUnits, BigInt.fromI32(11111100), BigInt.fromI32(11851857)));
    assert.fieldEquals("PortfolioGroup", "4", "highOutstanding", "0");
    assert.fieldEquals("PortfolioGroup", "4", "reserveLocked", "11851857");

    // Settle calm side:
    handlePortfolioSettled(createPortfolioSettledEvent(groupId, writer, false, cUnits, BigInt.fromI32(11851857), BigInt.zero()));
    assert.fieldEquals("PortfolioGroup", "4", "calmOutstanding", "0");
    assert.fieldEquals("PortfolioGroup", "4", "reserveLocked", "0");
  });
});
