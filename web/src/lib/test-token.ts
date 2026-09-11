/**
 * Quote-token honesty.
 *
 * On Base Sepolia the quote asset is Tremor's own MockUSDC: freely mintable, worth nothing, and its
 * ERC-20 `symbol()` returns the string "USDC". Wallets, explorers and every amount rendered in this app
 * therefore read as Circle USDC unless we say otherwise — so we say otherwise wherever money is shown.
 *
 * The logic lives here, free of React, so it can be unit-tested without a DOM harness.
 */

/** Only Base Sepolia (84532) quotes in the mintable mock. */
export const quoteTokenIsMock = (chainId: number): boolean => chainId === 84532;

/** The disclosure string. Kept to one line so it fits a single banner row on a phone. */
export const TEST_TOKEN_DISCLOSURE =
  "MockUSDC — freely mintable Base Sepolia test token; no real-world value.";
