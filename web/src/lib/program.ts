/**
 * SwapVM program decoding for the series page "program viewer".
 *
 * Order.data layout (MakerTraitsLib.build): tokenA(20) tokenB(20) [hook slices...] program.
 * The program offset is the 4th 16-bit slice index stored in `traits` at bit 160 + 48 = 208.
 * Program bytes are a flat list of `[opcode:1][argsLength:1][args]` (ContextLib.runLoop).
 */
import { hexToBigInt, hexToNumber, size, slice, type Address, type Hex } from "viem";
import { fmtDateTime } from "./format";

export type OpcodeKind = "tremor" | "stock";

export interface OpcodeInfo {
  code: number;
  name: string;
  kind: OpcodeKind;
  summary: string;
  argsLayout?: string;
}

/**
 * Tremor's own instructions — of which there are now none.
 *
 * v1 shipped four custom opcodes in the unallocated `0xd0..0xef` bank, which meant Tremor had to
 * deploy its own router to execute them. v2 ships only stock SwapVM instructions and puts all of the
 * pricing behind the built-in `Extruction` (0x04), whose target is `TremorMarketEngine`. That is why
 * the programs run on the unmodified official `AquaSwapVMRouter`, and it is why this list is empty:
 * the claim is custom SwapVM *programs* and external pricing logic, not custom opcodes.
 */
export const TREMOR_OPCODES: OpcodeInfo[] = [];

/** What a Tremor program's `Extruction` target is, for the viewer's annotation. */
export const EXTRUCTION_TARGET = {
  name: "TremorMarketEngine",
  summary:
    "Prices all three legs. Immutable arguments select the mode: 1 ISSUE (USDC to receipt, exact-in or exact-out), 2 EXIT (receipt to USDC before expiry), 3 SETTLE (receipt to USDC at the final payout). Quote and swap run identical arithmetic; only a swap writes the reservation and the inventory skew.",
  argsLayout: "version(1) mode(1) seriesId(8)",
} as const;

const STOCK: Array<[number, string]> = [
  [0x00, "Stop"], [0x01, "Revert"], [0x02, "Salt"], [0x03, "Jump"], [0x04, "Extruction"],
  [0x10, "PrintSwapRegisters"], [0x11, "PrintSwapQuery"], [0x12, "PrintVM"], [0x13, "PrintFreeMemoryPointer"],
  [0x14, "PrintGasLeft"], [0x15, "PrintFee"], [0x1a, "PatchSwapRegisters"],
  [0x20, "Deadline"], [0x23, "OnlyTakerTokenBalanceNonZero"], [0x24, "OnlyTakerTokenBalanceGte"],
  [0x25, "OnlyTakerTokenSupplyShareGte"], [0x26, "OnlyTxOriginTokenBalanceNonZero"], [0x2b, "PrivateOrder"],
  [0x2c, "WhitelistCoequal"], [0x2d, "WhitelistSequential"], [0x30, "JumpIfDirection"], [0x31, "JumpIfTokenIn"],
  [0x32, "JumpIfTokenOut"], [0x40, "InvalidateBit"], [0x41, "InvalidateTokenIn"], [0x42, "InvalidateTokenOut"],
  [0x48, "ValidateSeriesEpoch"], [0x50, "XYCSwap"], [0x51, "XYCConcentrateSwap"], [0x53, "LimitSwap"],
  [0x54, "LimitSwapFullAmount"], [0x58, "PeggedSwap"], [0x70, "FeeFlatIn"], [0x71, "FeeFlatOut"],
  [0x72, "FeeProgressiveIn"], [0x73, "FeeProgressiveOut"], [0x80, "FeeProtocol"], [0x90, "StaticBalances"],
  [0x91, "DynamicBalances"], [0x94, "DutchAuctionBalanceIn"], [0x95, "DutchAuctionBalanceOut"],
  [0x98, "PiecewiseLinearScaleBalanceIn"], [0x99, "PiecewiseLinearScaleBalanceOut"], [0x9c, "Decay"],
  [0x9d, "TWAPSwap"], [0xb0, "RequireMinRate"], [0xb1, "AdjustMinRate"], [0xb2, "OraclePriceAdjuster"],
  [0xb4, "BaseFeeAdjuster"],
];

const TABLE = new Map<number, OpcodeInfo>();
for (const [code, name] of STOCK) TABLE.set(code, { code, name, kind: "stock", summary: "" });
for (const op of TREMOR_OPCODES) TABLE.set(op.code, op);

export const opcodeInfo = (code: number): OpcodeInfo =>
  TABLE.get(code) ?? { code, name: `UNKNOWN_${hex1(code)}`, kind: "stock", summary: "" };

export const hex1 = (n: number): string => `0x${n.toString(16).padStart(2, "0")}`;

export interface DecodedArg {
  label: string;
  value: string;
  raw: string;
}

export interface Instruction {
  pc: number;
  opcode: number;
  name: string;
  kind: OpcodeKind;
  args: Hex;
  decoded: DecodedArg[];
  error?: string;
}

export interface DecodedOrder {
  maker: Address;
  tokenA: Address;
  tokenB: Address;
  programOffset: number;
  program: Hex;
  flags: {
    shouldUnwrapWeth: boolean;
    useAquaInsteadOfSignature: boolean;
    allowZeroAmountIn: boolean;
    hasPreTransferInHook: boolean;
    hasPostTransferInHook: boolean;
    hasPreTransferOutHook: boolean;
    hasPostTransferOutHook: boolean;
  };
  receiver: Address;
  instructions: Instruction[];
  error?: string;
}

const bit = (traits: bigint, n: number): boolean => ((traits >> BigInt(n)) & 1n) === 1n;

export function decodeOrder(order: { maker: Address; traits: bigint; data: Hex }): DecodedOrder {
  const { maker, traits, data } = order;
  const len = size(data);
  const flags = {
    shouldUnwrapWeth: bit(traits, 255),
    useAquaInsteadOfSignature: bit(traits, 254),
    allowZeroAmountIn: bit(traits, 253),
    hasPreTransferInHook: bit(traits, 252),
    hasPostTransferInHook: bit(traits, 251),
    hasPreTransferOutHook: bit(traits, 250),
    hasPostTransferOutHook: bit(traits, 249),
  };
  const receiverRaw = traits & ((1n << 160n) - 1n);
  const receiver = (receiverRaw === 0n ? maker : (`0x${receiverRaw.toString(16).padStart(40, "0")}` as Address));
  const base: DecodedOrder = {
    maker,
    tokenA: "0x0000000000000000000000000000000000000000",
    tokenB: "0x0000000000000000000000000000000000000000",
    programOffset: 40,
    program: "0x",
    flags,
    receiver,
    instructions: [],
  };
  if (len < 40) return { ...base, error: `order.data is ${len} bytes; expected at least 40` };
  const tokenA = slice(data, 0, 20) as Address;
  const tokenB = slice(data, 20, 40) as Address;
  const programOffset = Number((traits >> 208n) & 0xffffn) || 40;
  if (programOffset > len) return { ...base, tokenA, tokenB, programOffset, error: "program offset beyond data" };
  const program = slice(data, programOffset) as Hex;
  return { ...base, tokenA, tokenB, programOffset, program, instructions: decodeProgram(program) };
}

export function decodeProgram(program: Hex): Instruction[] {
  const out: Instruction[] = [];
  const total = size(program);
  let pc = 0;
  while (pc < total) {
    const opcode = hexToNumber(slice(program, pc, pc + 1));
    const argsLen = pc + 1 < total ? hexToNumber(slice(program, pc + 1, pc + 2)) : 0;
    const start = pc + 2;
    const end = start + argsLen;
    const info = opcodeInfo(opcode);
    if (end > total) {
      out.push({ pc, opcode, name: info.name, kind: info.kind, args: "0x", decoded: [], error: "args exceed program length" });
      break;
    }
    const args = (argsLen > 0 ? slice(program, start, end) : "0x") as Hex;
    let decoded: DecodedArg[] = [];
    try {
      decoded = decodeArgs(opcode, args);
    } catch (e) {
      decoded = [{ label: "raw", value: args, raw: args }];
      void e;
    }
    out.push({ pc, opcode, name: info.name, kind: info.kind, args, decoded });
    pc = end;
    if (opcode === 0x00) break; // Stop
  }
  return out;
}

// ---------------------------------------------------------------- packed-arg decoders

class Reader {
  private off = 0;
  constructor(private readonly hex: Hex) {}
  get remaining(): number {
    return size(this.hex) - this.off;
  }
  take(n: number): Hex {
    if (this.off + n > size(this.hex)) throw new Error("short args");
    const h = slice(this.hex, this.off, this.off + n) as Hex;
    this.off += n;
    return h;
  }
  address(): Address {
    return this.take(20) as Address;
  }
  uint(n: number): bigint {
    return hexToBigInt(this.take(n));
  }
}

/** The v1 engine's three modes, as its immutable program arguments encode them. */
const MODE_LABEL: Record<number, string> = { 1: "ISSUE", 2: "EXIT", 3: "SETTLE" };

/** Args version 2: the Extruction target is `TremorPortfolioMarket` and the mode is a PMode. */
const PMODE_LABEL_V2: Record<number, string> = {
  1: "ISSUE_HIGH",
  2: "ISSUE_CALM",
  3: "EXIT_HIGH",
  4: "EXIT_CALM",
  5: "SETTLE_HIGH",
  6: "SETTLE_CALM",
};

export const EXTRUCTION_TARGET_V2 = {
  name: "TremorPortfolioMarket",
  summary:
    "Prices all six legs of a risk group at the writer's fixed quotes. Immutable arguments select the mode: 1 ISSUE_HIGH, 2 ISSUE_CALM (USDC to receipt; exact-in or exact-out), 3 EXIT_HIGH, 4 EXIT_CALM (receipt to USDC before expiry, paid from released reserve plus the exit buffer), 5 SETTLE_HIGH, 6 SETTLE_CALM (receipt to USDC at the fixed payout).",
  argsLayout: "version(1)=2 mode(1) groupId(8)",
} as const;

const arg = (label: string, raw: Hex | bigint | string, value: string): DecodedArg => ({
  label,
  value,
  raw: typeof raw === "bigint" ? raw.toString() : raw,
});

function decodeArgs(opcode: number, args: Hex): DecodedArg[] {
  const r = new Reader(args);
  switch (opcode) {
    case 0x02: {
      // Salt: uint64 (series id), uint64+uint8 (group id + PMode), or opaque bytes
      if (size(args) === 8) {
        const v = r.uint(8);
        return [arg("salt", v, `${v.toString()} (series id)`)];
      }
      if (size(args) === 9) {
        const groupId = r.uint(8);
        const mode = hexToNumber(r.take(1));
        return [
          arg("groupId", groupId, `${groupId.toString()} (risk group)`),
          arg("mode", mode.toString(), `${mode} · ${PMODE_LABEL_V2[mode] ?? "unknown"}`),
        ];
      }
      return [arg("salt", args, args)];
    }
    case 0x20: {
      const v = r.uint(5);
      return [arg("deadline", v, `${v.toString()} · ${fmtDateTime(Number(v))}`)];
    }
    case 0x04: {
      // Extruction: [address target][bytes extructionArgs]. Tremor's args are
      // [version:1][mode:1][id:8], so a program can be read without any Tremor-specific ABI.
      // Version 1 targets TremorMarketEngine (seriesId, modes ISSUE/EXIT/SETTLE); version 2 targets
      // TremorPortfolioMarket (groupId, the six PModes).
      const target = r.address();
      const rest = size(args) > 20 ? slice(args, 20) : ("0x" as Hex);
      if (size(rest) === 10) {
        const version = hexToNumber(slice(rest, 0, 1));
        const mode = hexToNumber(slice(rest, 1, 2));
        const id = hexToBigInt(slice(rest, 2, 10));
        const v2 = version === 2;
        const targetName = v2 ? EXTRUCTION_TARGET_V2.name : EXTRUCTION_TARGET.name;
        const modeLabel = v2 ? PMODE_LABEL_V2[mode] : MODE_LABEL[mode];
        return [
          arg("target", target, `${target} (${targetName})`),
          arg("version", version.toString(), `v${version}`),
          arg("mode", mode.toString(), `${mode} · ${modeLabel ?? "unknown"}`),
          arg(v2 ? "groupId" : "seriesId", id, id.toString()),
        ];
      }
      const out: DecodedArg[] = [arg("target", target, `${target} (${EXTRUCTION_TARGET.name})`)];
      if (size(rest) > 0) out.push(arg("extructionArgs", rest, rest));
      return out;
    }
    default:
      return size(args) ? [arg("args", args, args)] : [];
  }
}

/** Human-readable listing, e.g. for the docs page. */
export const PROGRAM_LAYOUTS = {
  issue: "Salt(id,1) · Deadline(saleEnd) · Extruction(engine, [1,1,id])",
  exit: "Salt(id,2) · Deadline(expiry) · Extruction(engine, [1,2,id])  + postTransferIn hook → receipt",
  settle: "Salt(id,3) · Extruction(engine, [1,3,id])  + postTransferIn hook → receipt",
} as const;
