import type { Metadata } from "next";
import { HedgeCalculator } from "@/components/hedge/HedgeCalculator";
import { PageHeader } from "@/components/ui/SectionRow";

export const metadata: Metadata = { title: "Hedge" };

export default function HedgePage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        label="Hedge"
        title="Size a hedge against LVR"
        body="Loss-versus-rebalancing is a variance bill. Pool value and horizon in; expected LVR and units per live series out."
      />
      <HedgeCalculator />
    </div>
  );
}
