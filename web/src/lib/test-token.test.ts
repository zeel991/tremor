import { describe, expect, it } from "vitest";
import { quoteTokenIsMock, TEST_TOKEN_DISCLOSURE } from "./test-token";

/**
 * The Base Sepolia quote asset is Tremor's own MockUSDC, whose ERC-20 `symbol()` returns the string
 * "USDC". Without a disclosure every screen reads as Circle USDC, which would be dishonest on a public
 * deployment. These tests pin both halves of that disclosure: the wording, and the chains it applies to.
 */
describe("test-token disclosure", () => {
  it("applies on Base Sepolia, where the quote token is the freely mintable mock", () => {
    expect(quoteTokenIsMock(84532)).toBe(true);
  });

  it("does not apply on the local fork or Base mainnet, which use real USDC", () => {
    // 31337 forks Base mainnet (real USDC at 0x8335…); 8453 is Base mainnet itself. Showing the mock
    // warning there would assert a falsehood in the other direction.
    expect(quoteTokenIsMock(31337)).toBe(false);
    expect(quoteTokenIsMock(8453)).toBe(false);
    expect(quoteTokenIsMock(1)).toBe(false);
  });

  it("names the token, its mintability, and its lack of value", () => {
    expect(TEST_TOKEN_DISCLOSURE).toContain("MockUSDC");
    expect(TEST_TOKEN_DISCLOSURE).toContain("freely mintable");
    expect(TEST_TOKEN_DISCLOSURE).toContain("Base Sepolia");
    expect(TEST_TOKEN_DISCLOSURE).toContain("no real-world value");
  });

  it("never presents the mock as Circle USDC", () => {
    // A disclosure that says "USDC" without qualification is the defect it exists to fix.
    expect(TEST_TOKEN_DISCLOSURE).not.toMatch(/\bCircle\b/);
    expect(TEST_TOKEN_DISCLOSURE).not.toMatch(/(^|[^k])\bUSDC\b/);
  });

  it("stays short enough to sit in one banner line", () => {
    expect(TEST_TOKEN_DISCLOSURE.length).toBeLessThanOrEqual(90);
  });
});
