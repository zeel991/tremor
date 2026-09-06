# Tremor and the 1inch Aqua track

## Recommendation

Prioritize a bounded pivot from separately backed variance receipts to **portfolio-backed capped volatility markets**. The technical contribution should be a SwapVM execution primitive that prices a fill and enforces the worst-case payout of the resulting claim portfolio. Tremor supplies the application, oracle history, and settlement demonstration.

This is the strongest candidate identified in this comparison, not a proven optimum or a prediction of a prize. Allocate six focused engineering hours to establishing feasibility. Keep the existing implementation as a fallback. Do not spend the remaining days building an unrestricted derivatives platform.

The confirmed deadline is September 13, 2026; its exact hour remains to be checked. One builder covers contracts and frontend, assisted by coding-agent teams. Integration and review capacity, rather than code-generation volume, constrain the project.

## Evidence and limitations

The comparison uses the supplied 23-row Lisbon CSV, selected Buenos Aires and New York showcase pages, current official Aqua/SwapVM documentation, selected public source files, and Tremor's local contracts. The CSV contains three main Aqua winners, two continuity winners, and eighteen projects without a listed 1inch award. This is not a verified census of eligible main-track applicants; it must not be used to estimate a win rate. [1]

Showcase award labels establish published outcomes. Project descriptions establish what teams said they built. Source inspection supports narrow structural findings. No competitor test suites, deployed contracts, or demo videos were executed in this research. Current repository revisions may differ from judged submissions. No judging notes were available, and missing award labels do not establish disqualification, rejection reasons, or inferior engineering.

The workshop account and mentor conversation are supplied testimony. They reinforce the importance of meaningful custom work and enforceable obligations, but neither is a complete scoring rubric.

## Aqua and SwapVM capabilities

Aqua separates the liquidity registry from applications' trading logic. Makers ship immutable strategy configurations with virtual token allocations. Assets remain outside Aqua until execution; multiple strategies can refer to the same real inventory. Aqua's registry keys balances by maker, application, strategy hash, and token. It provides ship/dock lifecycle operations and pull/push settlement operations. [2]

The important application opportunity is **shared access without pre-fragmenting all capital into isolated strategy pools**. The important boundary is that virtual allocations are not enforceable future collateral commitments by themselves. A revocable spot quote and an issued future claim require different protections.

SwapVM provides programmable execution with amount and balance registers, control flow, stateful instruction behavior, and common final settlement. Custom instructions can express economic behavior inside that execution model. They must preserve quote/execution consistency at the same state and respect token-transfer and rounding semantics. The current official documentation also supports external logic through Extruction; putting code behind that instruction is not inherently illegitimate. [3][4]

The 2026 ETHOnline rubric explicitly rewards SwapVM use, permits modified SwapVM redeployments, requires official contracts, demonstrated on-chain token transfers, and meaningful Git history. Local forks qualify for the token-transfer demonstration. Main and continuity tracks are separate. [5]

## Comparative findings

| Project | Published result | Specific contribution described | Implication |
|---|---|---|---|
| Aqua Outcome Market | Buenos Aires Aqua first | Prediction-market-specific AMM mathematics, custom instructions, JIT inventory | Implement research as executable financial behavior. |
| aqua-flash-loans | Buenos Aires Aqua second | Direct Aqua single/dual-token flash loans; deliberately avoided SwapVM | Custom instructions are not necessary in every cohort. |
| Cleverly Using Money | Buenos Aires Aqua second | Private vault participating in shared Aqua strategies | Contract-held assets are not automatically incompatible with an Aqua award. |
| RiverSwap | New York Aqua first | Auction-managed fees with custom fee accounting and distributed-order indexing | Connect a market mechanism to an actual execution/accounting primitive. |
| Lotus | New York Aqua second | One-way liquidity, custom fills, shared execution core | A clear economic invariant can anchor the product. |
| TenorFi | New York Aqua third | Periodic funding-rate settlement through a custom instruction | Derivative settlement can fit; an award does not validate every safety claim. |
| ArcBook | Lisbon Aqua first | Executable curves, stateful custom fills and inventory recycling | Substantive state transitions plus accessible execution evidence. |
| Votive | Lisbon Aqua second | Conditional markets with custom execution gates | Application-specific conditions can count; pure AMMs are not the only route. |
| KSwap-VM | Lisbon Aqua third | Formal instruction/composition semantics and reported reproduced counterexamples | Ecosystem tooling can win; earlier blanket dismissal of tooling was wrong. |

Sources: [6]–[14]. These are descriptive comparisons, not causal explanations of the awards.

The three first-place projects above each describe a custom instruction implementing a financial mechanism. This supports prioritizing substantive VM work. It does not establish that an instruction caused the award or that every winning cohort follows the same pattern.

### Counterexamples prevent a false formula

| Comparison submission | Relevant evidence | What cannot be concluded |
|---|---|---|
| bebècita / bebecita | Custom capacity instruction, JIT inventory, detailed adversarial claims; no 1inch prize in CSV | Cannot say custom instructions, tests, or a real mechanism were absent. |
| Doca Finance | Inventory-aware dynamic fee provider and a reported controlled benchmark; no listed 1inch award | Cannot say benchmarking alone distinguishes winners. |
| QilinSwap | Strategy compiler, custom instructions, indexed history, reported tests; no listed 1inch award | Cannot say technical breadth or instruction count is enough. |
| wave | Custom inventory and oracle guards, compiler and social market; no listed 1inch award | A reusable guard is not an uncontested niche. |
| Superpose | Covered calls, shared collateral, guard and custom instruction; only a 0G award listed | Derivatives plus a solvency guard is already close prior art. |
| Smile | Options surface with Aqua/SwapVM, only Uniswap award listed | A broader derivatives platform is not demonstrably a better bet. |

Sources: [1], [15]–[20]. Absence of a listed award is not evidence of the judges' reasoning.

### Narrow source-level checks

At ArcBook revision `9039b86fa1369481aac577cdb5cd6a85d5695929`, `LiquidCurveInstruction` obtains a position quote, writes both amount registers, returns without state mutation in static context, and otherwise records the resulting runtime. This is substantive instruction behavior, although calculations use an external kernel. A winning instruction therefore need not inline all mathematics. [21]

At Superpose revision `549775d08186b51a33d3ef5f9b2920518ed9ff0c`, the guard adds per-strategy reservations into a total. Its instruction compares outgoing amount to free headroom. The guard explicitly documents that it only binds participating applications and that an unguarded application can still drain the maker. These files do not implement a common-outcome maximum-payout portfolio envelope. This is a narrow code observation, not an audit of the full project or an explanation of its award outcome. [22][23]

At bebecita revision `8b6c125386bdfb99efcec20b131120ae3106a19d`, the custom instruction clamps output balance using free tokens plus conservatively estimated reachable inventory. This is another reason not to pitch a basic capacity clamp as new. [24]

## What the pattern actually supports

There is no reliable feature present in all winners and absent from non-winners. The usable pattern is a selection discipline:

1. Start with a specific economic or protocol problem.
2. Make Aqua/SwapVM materially participate in its solution.
3. Implement the defining behavior, not only its interface.
4. Demonstrate the mechanism against a credible baseline and an adverse case.
5. Make the contribution understandable and inspectable.

These criteria are a strategic inference, not a recovered judging formula. They help reject weak directions but cannot rank unknown competitors or quantify winning probability.

## Why the current Tremor pitch needs sharpening

Tremor already has a restricted maker vault, aggregate reservations per series, capped payouts, early exits, and permissionless finalization. The controller reprices obligations at finalization and releases cap surplus. The existing engine computes trading capacity and authenticated fills behind Extruction. These are useful implemented features, not proposed novelty. [25]

However, sharing one balance between EXIT and SETTLE does not demonstrate unique portfolio capital efficiency: both paths consume the same claim. A competent conventional contract need not collateralize that claim twice either.

The stronger question is whether **different outstanding claims**, not alternative redemption routes, can safely share backing because their maximum payouts cannot occur together.

## Proposed product: portfolio-backed volatility markets

Begin with one observation window, one oracle statistic, one collateral asset, and two complementary capped claims. Call them HIGH and CALM in the prototype, with explicit payoff descriptions. CALM is a prepaid inverse capped-variance claim, not an uncapped leveraged short.

Define a normalized settlement value:

`x = min(realizedVariance / capVariance, 1)`, where `0 <= x <= 1`.

For a one-dollar payout scale:

- HIGH pays `x` dollars.
- CALM pays `1 - x` dollars.

With `h` HIGH claims and `c` CALM claims sold, the maximum aggregate payout is:

`R(h,c) = max over x in [0,1] of [h*x + c*(1-x)] = max(h,c)` dollars.

The maximum occurs at an endpoint because the aggregate function is affine. This is a mathematical derivation. It is not a live-market measurement.

| Outstanding claims | Separate full-cap backing | Aggregate worst-case backing |
|---|---:|---:|
| 100 HIGH | $100 | $100 |
| 100 HIGH + 100 CALM | $200 | $100 |
| 80 HIGH + 100 CALM | $180 | $100 |

The balanced example halves backing relative to a separately collateralized full-cap baseline. It is not a universal saving, yield claim, or advantage over every existing derivatives protocol. Complementary complete sets are established prior art, including Gnosis Conditional Tokens. Merely creating two complementary tokens is not the proposed innovation. [26]

The candidate contribution is **portfolio-aware execution and capacity shared by multiple Aqua strategies**, with mandatory exposure accounting and verifiable solvency. The instruction should size and price executable fills against the portfolio's remaining capacity, rather than simply sum independent caps or trust wallet observations.

### Optional generalization, only after the core works

For nonnegative bounded piecewise-linear payoff functions `f_i(x)`, use:

`R(q) = max_x sum_i q_i * f_i(x)`.

With a common piecewise-linear domain, the real-valued maximum is at a domain endpoint or a breakpoint from the union of payoff knots. Evaluate those points exactly, with conservative integer rounding. Do not substitute a sparse statistical stress grid for a worst-case bound.

A minimal third test shape is RANGE, paying `1 - abs(2*x - 1)`. With 100 HIGH, 100 CALM and 50 RANGE, the maximum is $150 at the interior knot x=0.5, versus $250 summed caps. An implementation checking only x=0 and x=1 would incorrectly reserve $100. This is an excellent correctness test, not a reason to build a payoff-design UI.

The four numeric examples were cross-checked using rational arithmetic on 101 grid points. The analytical endpoint/breakpoint argument establishes the continuous maximum; the grid check is only an independent arithmetic check. No Solidity prototype has been executed.

### The critical exit problem

Start with $100 cash backing 100 HIGH and 100 CALM. Buy back 20 HIGH for $5. Remaining maximum liability is still $100, but cash is now $95. That exit must fail unless free cash funds it.

Removing a nonnegative claim cannot increase the absolute required reserve, but it may release **zero** reserve. The existing assumption that a burn releases enough liability to fund a positive exit cannot simply be copied into this model.

Every completed transition must satisfy:

`actual collateral after transfers >= worst-case payout of remaining outstanding claims`.

Premiums can add free cash but do not create a riskless business. Solvency, trading profitability, and early-exit liquidity are separate properties. Validate complementary price relationships and round-trip behavior; do not copy the current skew model independently onto both tokens.

### Required safety boundaries

- Group claims only by identical settlement statistic, observation window, oracle rules, payout denomination and finalization semantics.
- Never net different expiries or merely correlated assets in the prototype.
- Keep backing in a constrained contract with no writer-controlled escape path.
- Count actual outstanding claims, excluding strictly inaccessible unsold inventory.
- Authenticate every order and exposure-changing path. Programs omitting the instruction must not bypass authoritative accounting.
- Account for settlement ordering, fees, hooks, reentrancy and callbacks. The VM's computed amounts precede final transfers; register checks alone are insufficient.
- Reserve before relying on unreceived premiums unless atomic ordering and solvency have been proved.
- Distinguish quote/state consistency from a promise that a quote survives later market changes.
- Finalize the shared observation once. Redeem all claims against the same immutable result in any holder order.
- Document oracle liveness and collateral-token risks, including transfer failures or issuer freezes.

## Implementation decision

| Direction | Strategic assessment | Decision |
|---|---|---|
| Polish current Tremor only | Best delivery certainty, weaker new sponsor-specific contribution | Preserve as fallback. |
| Add a generic solvency/capacity guard | Close prior art; risks cosmetic refactoring | Do not make this the headline. |
| Portfolio-backed capped volatility execution | Clear capital comparison, real shared-liability problem, reuses oracle and app | Lead candidate, contingent on a six-hour prototype. |
| New leveraged lending/AMM product | Large review surface and unfamiliar liquidation/credit assumptions | Reject for the remaining schedule. |
| Formal-verification tooling pivot | Valid prize category historically, but specialist ramp and prior art | Do not pivot without an already concrete original finding. |

The portfolio recommendation is an engineering judgment. An unknown competitor, judge preference, or prototype failure could change it. The full protocol does not mathematically require Aqua; Aqua supplies shared strategy allocation and execution infrastructure. SwapVM supplies the reusable fill program. Do not claim that the underlying collateral mathematics is impossible elsewhere.

## Execution through September 13

### September 9: decision and proof

Confirm submission hour and eligibility. Freeze the baseline locally. Specify the exact two-claim payoff, outstanding-supply accounting, rounding and settlement order. Build an isolated reference model and minimal contract experiment only after implementation is authorized. Use one named integration owner.

Within six focused hours require: actual Aqua/SwapVM ISSUE execution, matched quote/fill amounts, measured reservation changes for both claims, and rejection of the $95-cash/$100-liability exit. A pure arithmetic model or compiling router is not a passing gate.

If this fails, stop the pivot. Ship the existing protected market and focus on its strongest demonstrated execution properties. Do not compress security review to preserve a new idea.

### September 10: protocol and invariants

Complete approved instruction and controller changes. Pin the dispatch ABI to the actual dependency version; the local router uses a dispatch path, so examples overriding an unrelated opcode-list API must not be copied blindly. Keep upstream files untouched.

Test mismatched settlement domains, claim transfer, partial fills, both burn paths, empty/dust balances, premature finalization, repeated execution, and cross-program reentrancy. Run stateful campaigns with successful actions, not only reverted calls. Include the interior-knot RANGE case as a test-only generalization if feasible.

Treat this as a new version. Existing immutable vaults, receipts and routers cannot be silently migrated. Preserve old deployments and explicit provenance.

### September 11: end-to-end integration

Refresh ABIs, manifests, Lens and event models together. Add a concise portfolio view showing cash, summed standalone caps, actual portfolio reserve and free collateral. Use the same versioned math in displayed estimates; executable quotes remain on chain.

Reuse the chart and history infrastructure. Do not rebuild indexing wholesale. Demonstrate one transaction through receipt, event, indexer and UI. Clearly distinguish historical observations, reconstructed market estimates and current executable quotes.

Freeze feature additions by the end of the day. If time is lost, remove general payoff support and additional analytics first.

### September 12: independent execution and recording

Run a pinned Base-fork lifecycle with real historical feed data and a separate public testnet flow with clearly identified test assets. Have a holder redeem without writer cooperation. Validate every explorer link, source revision and address. Reproduce in a fresh browser.

Record the three-minute demonstration and keep an executable CLI fallback. Have someone unfamiliar with the repository follow the instructions if available. Fix blockers only.

### September 13: submission buffer

Confirm the actual cutoff and submit with buffer. Disclose pre-existing work and exact hackathon changes. Avoid a last-minute router migration. Public deployments, pushes, messages and submissions require explicit permission.

Coding-agent teams can split independent reference math/adversarial tests, contract work, and frontend work only after the interfaces are frozen. One person integrates and verifies. Additional agents do not substitute for an independent security review.

## Demonstration and sponsor conversation

The core demonstration is: sell HIGH, show its reservation; sell CALM, show why the additional standalone cap does not add the same amount to portfolio liability; attempt an unfunded exit and reject it; provide free cash and complete an allowed exit; finalize and pay both holders.

Explain the rejected transaction as a necessary consequence of shared backing, not a broken button. Show the worst-case payout curve and balances beside actual transaction results. A UI screenshot claiming a saving is weaker than an executable baseline comparison.

Suggested public mentor question, only after a prototype exists and only if sending is authorized:

> We replaced revocable EOA backing with a constrained maker account. We now calculate a common-outcome portfolio's maximum payout rather than adding separate caps, and our SwapVM fill path enforces that bound across two volatility claims. A prototype shows the collateral difference and rejects an exit that would strand the other claim. Does this demonstrate a useful Aqua/SwapVM contribution, and which failure case would you want us to show?

Ask for criticism of the mechanism, not assurance of a prize. Incorporate concrete feedback while keeping the deadline and safety gates intact.

## Sources

All online sources accessed September 9, 2026 unless noted. Showcase implementation descriptions are self-reported.

1. Supplied file: `/Users/zeeast/Downloads/ethglobal-lisbon2026-1inch-projects (1).csv`, 23 records, project and tracks_won fields plus descriptions.
2. 1inch, [Aqua repository and architecture](https://github.com/1inch/aqua).
3. 1inch, [SwapVM repository and instruction model](https://github.com/1inch/swap-vm).
4. 1inch, [Extruction implementation and warnings](https://github.com/1inch/swap-vm/blob/main/src/instructions/Extruction.sol).
5. ETHGlobal, [ETHOnline 2026 1inch requirements](https://ethglobal.com/events/ethonline2026/prizes/1inch).
6. ETHGlobal, [Aqua Outcome Market](https://ethglobal.com/showcase/aqua-outcome-market-0va0j).
7. ETHGlobal, [aqua-flash-loans](https://ethglobal.com/showcase/aqua-flash-loans-egocw).
8. ETHGlobal, [Cleverly Using Money](https://ethglobal.com/showcase/cleverly-using-money-pogqu).
9. ETHGlobal, [RiverSwap](https://ethglobal.com/showcase/riverswap-bat5v).
10. ETHGlobal, [Lotus](https://ethglobal.com/showcase/lotus-9vnou).
11. ETHGlobal, [TenorFi](https://ethglobal.com/showcase/tenorfi-06wnb).
12. ETHGlobal, [ArcBook](https://ethglobal.com/showcase/arcbook-twp2a).
13. ETHGlobal, [Votive](https://ethglobal.com/showcase/votive-p78qo).
14. ETHGlobal, [KSwap-VM](https://ethglobal.com/showcase/kswap-vm-aix5n).
15. ETHGlobal, [bebecita](https://ethglobal.com/showcase/bebecita-q55fm), also in supplied CSV.
16. ETHGlobal, [Doca Finance](https://ethglobal.com/showcase/doca-finance-rjm24), supplied CSV.
17. ETHGlobal, [QilinSwap](https://ethglobal.com/showcase/qilinswap-pzccy), supplied CSV.
18. ETHGlobal, [wave](https://ethglobal.com/showcase/wave-i97sc), supplied CSV.
19. ETHGlobal, [Superpose](https://ethglobal.com/showcase/superpose-ai0gv), supplied CSV.
20. ETHGlobal, [Smile](https://ethglobal.com/showcase/smile-fictr).
21. ArcBook, [LiquidCurveInstruction at inspected revision](https://github.com/Ryad2/liquid_OB/blob/9039b86fa1369481aac577cdb5cd6a85d5695929/contracts/src/core/LiquidCurveInstruction.sol).
22. Superpose, [SolvencyGuard at inspected revision](https://github.com/Thirumurugan7/Ethglobal-Lisbon/blob/549775d08186b51a33d3ef5f9b2920518ed9ff0c/src/SolvencyGuard.sol).
23. Superpose, [SolvencyGuardInstruction at inspected revision](https://github.com/Thirumurugan7/Ethglobal-Lisbon/blob/549775d08186b51a33d3ef5f9b2920518ed9ff0c/swapvm/src/SolvencyGuardInstruction.sol).
24. bebecita, [UnwindPricedBalances at inspected revision](https://github.com/gamween/bebecita/blob/8b6c125386bdfb99efcec20b131120ae3106a19d/contracts/src/instructions/UnwindPricedBalances.sol).
25. Local Tremor: `contracts/src/VarianceSeriesFactory.sol`, `TremorMarketEngine.sol`, `TremorMakerVault.sol`, `tokens/VarianceReceipt.sol`, and `ARCHITECTURE.md`; inspected, not freshly tested in this research.
26. Gnosis, [Splitting and Merging Positions](https://ct-docs.gnosis.io/conditionaltokens/docs/devguide05).
