"use client";

import { useMemo, useState } from "react";
import { useOrders, useRpcOnline } from "@/lib/chain";
import { isDeployed } from "@/lib/contracts";
import { cx, shortAddr } from "@/lib/format";
import { EXTRUCTION_TARGET, decodeOrder, hex1, type DecodedOrder, type Instruction } from "@/lib/program";
import type { SeriesState } from "@/lib/series";
import { Card } from "@/components/ui/Card";
import { Tag } from "@/components/ui/Tag";
import { Segmented } from "@/components/ui/Segmented";
import { SkeletonText } from "@/components/ui/Skeleton";
import { EmptyState } from "@/components/ui/EmptyState";

/** One `[opcode] Name` row. The Extruction that calls Tremor's engine gets a 2px lime left border. */
function InstructionRow({ ins }: { ins: Instruction }) {
  const [open, setOpen] = useState(ins.kind === "tremor");
  const tremor = ins.kind === "tremor";
  return (
    <li className={cx("ins", tremor && "ins-tremor")}>
      <button type="button" className="mono flex w-full items-center gap-3 text-left text-[13px]" onClick={() => setOpen((o) => !o)} aria-expanded={open}>
        <span className={cx(tremor ? "text-ink" : "text-ink-3")}>[{hex1(ins.opcode)}]</span>
        <span className={cx("font-medium", tremor ? "text-ink" : "text-ink-2")}>{ins.name}</span>
        <span className="ml-auto text-[11px] text-ink-3">
          pc {ins.pc} · {ins.args === "0x" ? 0 : (ins.args.length - 2) / 2} B
        </span>
      </button>
      {open && (ins.decoded.length > 0 || ins.error) ? (
        <dl className="ins-args mono m-0 mt-2 grid grid-cols-[minmax(110px,auto)_1fr] gap-x-4 gap-y-1 px-3 py-2 text-[12px]">
          {ins.error ? <dd className="col-span-2 m-0 text-down">{ins.error}</dd> : null}
          {ins.decoded.map((d) => (
            <div key={d.label} className="contents">
              <dt className="text-ink-3">{d.label}</dt>
              <dd className="m-0 break-all text-ink">{d.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
    </li>
  );
}

function OrderView({ o, raw }: { o: DecodedOrder; raw: boolean }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        <Tag tone="muted" className="mono" title={o.tokenA}>
          tokenA {shortAddr(o.tokenA)}
        </Tag>
        <Tag tone="muted" className="mono" title={o.tokenB}>
          tokenB {shortAddr(o.tokenB)}
        </Tag>
        <Tag tone={o.flags.useAquaInsteadOfSignature ? "lime" : "down"}>{o.flags.useAquaInsteadOfSignature ? "Aqua-backed" : "signature order"}</Tag>
        <Tag tone="dim">program @ byte {o.programOffset}</Tag>
      </div>
      {o.error ? <p className="small m-0 text-down">{o.error}</p> : null}
      {raw ? (
        <pre className="mono m-0 max-h-56 overflow-auto whitespace-pre-wrap break-all border border-line bg-bg-3 p-3 text-[11.5px] leading-5 text-ink-2">{o.program}</pre>
      ) : (
        <ol className="m-0 list-none border border-line p-0">
          {o.instructions.map((ins) => (
            <InstructionRow key={ins.pc} ins={ins} />
          ))}
        </ol>
      )}
    </div>
  );
}

export function ProgramViewer({ s }: { s: SeriesState }) {
  const orders = useOrders(s.id);
  const rpc = useRpcOnline();
  const [leg, setLeg] = useState<"issue" | "exit" | "settle">("issue");
  const [raw, setRaw] = useState(false);
  const decoded = useMemo(() => {
    if (!orders.data) return undefined;
    return {
      issue: decodeOrder(orders.data.issue),
      exit: decodeOrder(orders.data.exit),
      settle: decodeOrder(orders.data.settlement),
    };
  }, [orders.data]);

  return (
    <Card
      title="Program"
      meta="The three Aqua strategies, decoded from TremorPrograms.orders(id)"
      action={
        <button type="button" className="btn btn-tertiary btn-sm" onClick={() => setRaw((r) => !r)}>
          {raw ? "Decoded" : "Raw hex"}
        </button>
      }
    >
      <div className="flex flex-col gap-4">
        <Segmented
          label="Leg"
          value={leg}
          onChange={setLeg}
          options={[
            { value: "issue", label: "Issue" },
            { value: "exit", label: "Exit" },
            { value: "settle", label: "Settle" },
          ]}
        />
        {!isDeployed ? (
          <EmptyState>Contracts not deployed.</EmptyState>
        ) : rpc === false || orders.isError ? (
          <EmptyState>RPC unreachable — orders live on-chain.</EmptyState>
        ) : !decoded ? (
          <SkeletonText lines={4} />
        ) : (
          <OrderView o={decoded[leg]} raw={raw} />
        )}
        <details className="text-[13px] text-ink-2">
          <summary className="cursor-pointer select-none">Instruction table</summary>
          <p className="mt-2 text-ink-2">
            Every instruction here is stock SwapVM, which is why these programs run on the unmodified
            official router. Tremor&apos;s own logic sits behind <span className="mono">Extruction</span> and
            behind the receipt&apos;s burn hook — custom programs, not custom opcodes.
          </p>
          <table className="mt-2 w-full text-[12px]">
            <tbody>
              <tr className="align-top">
                <td className="mono py-1 pr-3 text-ink-3">[0x02]</td>
                <td className="mono py-1 pr-3 text-ink-2">Salt</td>
                <td className="py-1 text-ink-2">
                  Series id and leg — makes each of the three strategy hashes unique.
                </td>
              </tr>
              <tr className="align-top">
                <td className="mono py-1 pr-3 text-ink-3">[0x20]</td>
                <td className="mono py-1 pr-3 text-ink-2">Deadline</td>
                <td className="py-1 text-ink-2">
                  uint40 timestamp. Issue dies at sale end, exit at expiry. Settle carries none: a holder
                  who redeems years late still redeems.
                </td>
              </tr>
              <tr className="align-top">
                <td className="mono py-1 pr-3 text-ink">[0x04]</td>
                <td className="mono py-1 pr-3 text-ink">Extruction</td>
                <td className="py-1 text-ink-2">
                  {EXTRUCTION_TARGET.summary}
                  <div className="mono mt-0.5 text-[11px] text-ink-3">{EXTRUCTION_TARGET.argsLayout}</div>
                </td>
              </tr>
            </tbody>
          </table>
        </details>
      </div>
    </Card>
  );
}
