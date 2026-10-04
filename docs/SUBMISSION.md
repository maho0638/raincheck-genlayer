# RainCheck — reviewer submission notes

## Short description

RainCheck lets a user define rainfall-cover terms before an event, then uses GenLayer validator consensus to evaluate public weather evidence and settle a capped testnet payout.

## What to review

1. Open the landing page and read the fixed test terms: 0.002 GEN premium and 0.010 GEN maximum payout.
2. Open **Evidence Lab**. Choose a past UTC day and location, then fetch Open-Meteo Archive and NASA POWER readings. Compare the browser preview result with each source link. It is read-only and does not imply a contract verdict.
3. Open the Studionet explorer link and compare contract state with the read-only activity view.
4. Review `contracts/rain_check.py` and the tests for matching evidence, no trigger, source conflict, unavailable data/retry, reserve accounting and one-time payout behavior.

## GenLayer-specific implementation

The Intelligent Contract stores cover terms and reserve accounting. Settlement retrieves compact JSON evidence from two independent public endpoints inside the contract's nondeterministic evidence path. Validator agreement on the structured result is required before the deterministic state transition pays or releases reserve. Disagreement pauses for review; unavailable evidence remains retryable. The TypeScript frontend uses `genlayer-js` for Studionet reads and transaction integration; wallet writes are currently shut off as a deployment safety measure.

## Current deployment and limitation

Contract: `0xb94D1922362B0Ac6936e908DF677aC89D05dFC51` on Studionet.

The deployed prototype has no reserve withdrawal method and does not currently hold enough available reserve to cover a new 0.010 GEN payout. The new interface therefore disables wallet connection and all transaction writes. The Evidence Lab and contract reads remain usable without a wallet. Do not fund the existing address. Full on-chain demo transactions require a separately reviewed new contract and safe pool controls; this submission does not claim otherwise.

The Evidence Lab fetches live public archive APIs at runtime. Its result is a browser-side comparison, not an on-chain proof. API outage, source differences and spatial resolution can affect readings. Direct Mode tests use controlled responses and do not replace live multi-validator consensus or a live payout transaction.
