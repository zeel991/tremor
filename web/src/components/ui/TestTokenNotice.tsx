import { cx } from "@/lib/format";
import { env } from "@/config/env";
import { ADDR } from "@/lib/contracts";
import { Banner } from "./Banner";
import { quoteTokenIsMock, TEST_TOKEN_DISCLOSURE } from "@/lib/test-token";

/**
 * Renders the MockUSDC disclosure. The predicate and the wording live in `@/lib/test-token` so they can be
 * unit-tested without a DOM harness; this file is only the presentation.
 *
 * Only chain 84532 uses the mock. The local fork (31337) forks real Base USDC and Base mainnet (8453) uses
 * the real thing, so the notice must not appear there and imply a mock where there is none.
 */
export const QUOTE_TOKEN_IS_MOCK = quoteTokenIsMock(env.chainId);

export { TEST_TOKEN_DISCLOSURE };

/** One-line inline disclosure, for placing under a balance, price or ticket. */
export function TestTokenNote({ className }: { className?: string }) {
  if (!QUOTE_TOKEN_IS_MOCK) return null;
  return (
    <p className={cx("label", className)} data-testid="test-token-note">
      {TEST_TOKEN_DISCLOSURE}
    </p>
  );
}

/** Page-level banner for surfaces where money is the point: markets, pairs, portfolio, write. */
export function TestTokenBanner({ className }: { className?: string }) {
  if (!QUOTE_TOKEN_IS_MOCK) return null;
  return (
    <Banner tone="warning" className={className}>
      <span data-testid="test-token-banner">
        <b>{TEST_TOKEN_DISCLOSURE}</b> Every amount on this page is denominated in it. It is not Circle
        USDC — the token&rsquo;s own <code>symbol()</code> returns <code>&quot;USDC&quot;</code>.
        {ADDR.usdc ? (
          <>
            {" "}
            Contract <code className="tnum break-all">{ADDR.usdc}</code>.
          </>
        ) : null}
      </span>
    </Banner>
  );
}
