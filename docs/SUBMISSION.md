# RainCheck — reviewer submission notes

## Short description

RainCheck lets a user define rainfall-cover terms before an event, then uses GenLayer validator consensus to evaluate public weather evidence and settle a capped testnet payout.

## What to review

1. Open **Event planner**. Search/select a place, keep the UTC date and threshold synchronized with cover setup, and check the hourly forecast. Compare the trigger-load estimate and wettest hour with the forecast source. Export the JSON brief; it includes attribution and states that it is a forecast, not a payout decision.
2. Read the fixed test terms in **Protection**: 0.002 GEN premium and 0.010 GEN maximum payout.
3. Open **Evidence Lab**. Choose a past UTC day and location, then fetch Open-Meteo Archive and NASA POWER readings. Compare the browser preview result with each source link. It is read-only and does not imply a contract verdict.
4. Open the Studionet explorer link and compare contract state with the read-only activity view.
5. Review `contracts/rain_check.py` and the tests for matching evidence, no trigger, source conflict, unavailable data/retry, reserve accounting and one-time payout behavior.

## GenLayer-specific implementation

The Intelligent Contract stores fixed cover terms and reserve accounting. Settlement retrieves compact JSON evidence from two independent public endpoints inside the contract's nondeterministic evidence path. Validator agreement on the structured result is required before the deterministic state transition pays or releases reserve. Disagreement pauses for review; unavailable evidence remains retryable. RainCheck V2 adds deployer-only liquidity management: `fund_reserve` accepts deposits from the owner, while `withdraw_reserve` enforces `amount <= total_reserve - locked_payouts`. The frontend uses `genlayer-js`, checks the contract version and owner on Studionet, and refuses writes for any legacy address.

## Release state

- Production site: https://raincheck-genlayer.vercel.app
- Deployed V2 contract: `0xE25Cb5C035C7E0ae04C5Aa88aB673875bd5F20Ce`
- Legacy contract (read-only; do not fund): `0xb94D1922362B0Ac6936e908DF677aC89D05dFC51`
- A live browser check on 2026-10-05 confirmed `raincheck-v2`, a valid owner, 9.992 GEN available reserve and one on-chain ACTIVE cover. The Evidence Lab fetched both public sources successfully for its selected sample date and sent no transaction.

The deployed contract and production UI are connected. At the last recorded live check, the reserve had 9.992 GEN available and one ACTIVE cover. A new cover requires at least 0.008 GEN available reserve after existing locks. Only use Studionet test GEN. Do not use a mainnet wallet or real funds. The contract prevents withdrawals of reserve backing active covers.

The Event planner uses Open-Meteo's public forecast endpoint in the browser. Its load bands are explicit planning heuristics based on forecast accumulation divided by the user threshold; the precipitation chance is shown separately and is not the chance of a payout. Forecast days outside the provider's rolling horizon are unavailable. Open-Meteo says its free endpoint is non-commercial; production commercial use needs a commercial-use licence. The planner is not currently connected to insurer risk pricing, real-money coverage, alerts or a customer backend.

The Evidence Lab is a browser-side archive comparison, not an on-chain proof. API outage, source differences and spatial resolution can affect readings. Contract unit tests use controlled responses; Direct Mode exercises the contract evidence/consensus lifecycle against controlled responses. Live chain state confirms one funded cover was created; settlement and payout have not yet been exercised on the deployed contract. Recheck Studionet before submission because reserve and cover state can change.

## Limits and scoring

RainCheck demonstrates a real GenLayer consensus path, two independently fetched public evidence sources, a source-conflict review state, retryable missing data, reserve locking and a capped payout. Competitors such as Sensible already provide embedded offers, automatic reimbursements and business APIs; RainCheck is not at that commercial maturity and does not yet have real payouts. A possible first revenue test is a B2B multi-event monitor/white-label brief for outdoor venues, followed by insurance/MGA integration for real money protection. That would require commercial weather-data licensing, customer validation and a partner that can legally price and pay coverage. For GenLayer, useful production traffic can create protocol fee activity for consensus and validator work, but testnet GEN has no cash value and fees are not automatic RainCheck builder income. This candidate has no implemented customer billing, real-money cover or builder revenue. Protocol usage or ecosystem points are not a revenue guarantee. No verified public 4,000-point rubric is included with this project, so no score is promised.

## Current interface verification candidate

The unreleased working copy adds city search, a working event forecast desk with 24-hour detail, lower-rain alternative dates, threshold-relative action guidance, and a downloadable attributed event brief. It keeps forecasts distinct from archive evidence and on-chain settlement. It also retains the verified-contract monitor, refresh feedback, per-cover case files, and Evidence Lab from the prior candidate. No contract change or deployment is part of this UI feature. Automated checks pass; browser visual/interaction QA is still pending because the available browser blocks localhost and no local browser automation runtime is installed. Complete that check and the full release checklist before publishing this candidate.
