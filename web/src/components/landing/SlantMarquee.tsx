const PROTOCOL_ITEMS = [
  "Trade volatility, not direction",
  "Two sides. Both executable",
  "Every unit sold is collateralized",
  "Custom SwapVM programs",
  "Quote equals swap",
  "Chainlink-native settlement",
];

const MARKET_ITEMS = [
  "Oracle data becomes realized variance",
  "One day. Seven day. Thirty day",
  "Chainlink rounds, measured onchain",
  "Every fill moves the quote",
  "Variance is the underlying",
  "Live data. Verifiable settlement",
];

function MarqueeSet({ items, duplicate = false }: { items: string[]; duplicate?: boolean }) {
  return (
    <div className="slant-marquee-set" aria-hidden={duplicate || undefined}>
      {items.map((item) => (
        <span className="slant-marquee-item" key={item}>
          <i aria-hidden="true" />
          {item}
        </span>
      ))}
    </div>
  );
}

type SlantMarqueeProps = {
  variant?: "protocol" | "market";
};

/** A full-bleed kinetic band that summarizes one part of Tremor's market loop. */
export function SlantMarquee({ variant = "protocol" }: SlantMarqueeProps) {
  const isMarket = variant === "market";
  const items = isMarket ? MARKET_ITEMS : PROTOCOL_ITEMS;

  return (
    <section
      className={`slant-marquee bleed${isMarket ? " slant-marquee--hero" : ""}`}
      aria-label={isMarket ? "Tremor live variance loop" : "Tremor protocol loop"}
    >
      <div className="slant-marquee-track">
        <div className="slant-marquee-motion">
          <MarqueeSet items={items} />
          <MarqueeSet items={items} duplicate />
        </div>
      </div>
    </section>
  );
}
