import { Card } from "@/components/ui/Card";
import { AllocBar } from "@/components/ui/Hatch";
import { LinkButton } from "@/components/ui/Button";

const POOL = 100_000;
const DAYS = 7;
const SCENARIOS: Array<{ sigma: number; tone: "lime" | "ink" | "up" }> = [
  { sigma: 0.4, tone: "ink" },
  { sigma: 0.6, tone: "lime" },
  { sigma: 0.9, tone: "up" },
];
const lvr = (sigma: number) => (POOL * sigma * sigma * (DAYS / 365)) / 8;
const usd = (n: number) => n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

/** Allocation-style card: expected LVR at three vol scenarios, hatched remainder, CTA. */
export function LvrHook() {
  const max = lvr(SCENARIOS[SCENARIOS.length - 1].sigma);
  return (
    <div className="band band-slant-t bleed pb-12">
      <div className="mx-auto w-full max-w-[1280px] px-6">
        <Card title="Expected LVR" meta={`${usd(POOL)} constant-product position · ${DAYS} days`}>
          <div className="grid gap-8 lg:grid-cols-[1.5fr_1fr] lg:gap-12">
            <div className="flex flex-col">
              <div className="flex items-baseline justify-between gap-4">
                <span className="text-[16px] font-medium">V · σ² · T / 8</span>
                <span className="num-lg">{usd(lvr(0.6))}</span>
              </div>
              <div className="mt-4 flex flex-col gap-3">
                {SCENARIOS.map((sc) => (
                  <AllocBar
                    key={sc.sigma}
                    pct={(lvr(sc.sigma) / max) * 100}
                    tone={sc.tone}
                    label={`σ ${Math.round(sc.sigma * 100)}%`}
                  />
                ))}
              </div>
              <div className="mt-4 flex flex-wrap gap-x-6 gap-y-2">
                {SCENARIOS.map((sc) => (
                  <span key={sc.sigma} className="label inline-flex items-center gap-1.5">
                    <span className={`sdot ${sc.tone === "lime" ? "text-lime" : sc.tone === "ink" ? "text-ink" : "text-up"}`} />σ{" "}
                    {Math.round(sc.sigma * 100)}%<span className="text-ink tnum">{usd(lvr(sc.sigma))}</span>
                  </span>
                ))}
              </div>
            </div>
            <div className="flex flex-col justify-between gap-4">
              <div className="grid gap-2">
                <div className="border border-line p-3">
                  <div className="label">Receipt pays</div>
                  <div className="mt-1 text-[15px] font-medium">unitNotional · σ²</div>
                </div>
                <div className="border border-line p-3">
                  <div className="label">Units to hedge</div>
                  <div className="mt-1 text-[15px] font-medium">(V·T/8) / unitNotional</div>
                </div>
                <div className="border border-line p-3">
                  <div className="label">Custom SwapVM opcode · 0xd3</div>
                  <div className="mt-1 text-[15px] font-medium">VarianceSpread widens an Aqua AMM with √RV</div>
                  <div className="mt-1 text-[12px] text-ink-3">Fresh cache required; missing or stale volatility fails closed.</div>
                </div>
              </div>
              <LinkButton href="/hedge" className="w-full" size="lg">
                Open the LVR calculator
              </LinkButton>
            </div>
          </div>
        </Card>
      </div>
    </div>
  );
}
