# RainCheck — reviewer submission notes

## Short description

RainCheck lets a user define rainfall-cover terms before an event, then uses GenLayer validator consensus to evaluate public weather evidence and settle a capped testnet payout.

## What to review

1. Open the landing page and read the fixed test terms: 0.002 GEN premium and 0.010 GEN maximum payout.
2. Open **Evidence Lab**. Choose a past UTC day and location, then fetch Open-Meteo Archive and NASA POWER readings. Compare the browser preview result with each source link. It is read-only and does not imply a contract verdict.
3. Open the Studionet explorer link and compare contract state with the read-only activity view.
4. Review `contracts/rain_check.py` and the tests for matching evidence, no trigger, source conflict, unavailable data/retry, reserve accounting and one-time payout behavior.

## GenLayer-specific implementation

The Intelligent Contract stores fixed cover terms and reserve accounting. Settlement retrieves compact JSON evidence from two independent public endpoints inside the contract's nondeterministic evidence path. Validator agreement on the structured result is required before the deterministic state transition pays or releases reserve. Disagreement pauses for review; unavailable evidence remains retryable. RainCheck V2 adds deployer-only liquidity management: `fund_reserve` accepts deposits from the owner, while `withdraw_reserve` enforces `amount <= total_reserve - locked_payouts`. The frontend uses `genlayer-js`, checks the contract version and owner on Studionet, and refuses writes for any legacy address.

## Release state

- Production site: https://raincheck-genlayer.vercel.app
- Deployed V2 contract: `0xE25Cb5C035C7E0ae04C5Aa88aB673875bd5F20Ce`
- Legacy contract (read-only; do not fund): `0xb94D1922362B0Ac6936e908DF677aC89D05dFC51`
- Live browser check confirmed `raincheck-v2`, a valid owner, zero covers and 0 GEN available reserve. The Evidence Lab fetched both public sources successfully for its selected sample date and sent no transaction.

The deployed contract and production UI are connected. The live pool is empty, so creating a cover is currently disabled. To run the funded demo, the contract owner must connect the deployer wallet and add Studionet test GEN; the page defaults to 0.050 GEN funding. A new cover requires at least 0.008 GEN available reserve after existing locks. Only use Studionet test GEN. Do not use a mainnet wallet or real funds. The contract prevents withdrawals of reserve backing active covers.

The Evidence Lab is a browser-side comparison, not an on-chain proof. API outage, source differences and spatial resolution can affect readings. Contract unit tests use controlled responses; Direct Mode exercises the contract evidence/consensus lifecycle against controlled responses. No funded on-chain cover creation, settlement or payout has been exercised on the deployed contract yet.
