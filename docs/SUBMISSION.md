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

## Release state and final Studionet steps

The public address below is the legacy prototype; it remains read-only and must not receive deposits:

`0xb94D1922362B0Ac6936e908DF677aC89D05dFC51`

The V2 contract source and guarded UI are prepared and locally verified. To enable the complete on-chain demo, deploy `contracts/rain_check.py` from GenLayer Studio to Studionet using the wallet intended to own the reserve. Copy the resulting contract address into the Vercel Production `VITE_CONTRACT_ADDRESS` setting, redeploy once, then open the page and confirm the header says `RainCheck V2` and the reserve panel says `V2 · OWNER WALLET` after connecting the same deployer wallet. Fund only with Studionet test GEN. Do not use a mainnet wallet or real funds. Cover creation requires at least 0.008 GEN available reserve; the example owner funding value is 0.050 GEN. The contract will never allow withdrawing reserve backing active covers.

Until those two account-scoped steps are completed, the published page continues to use the legacy read-only deployment. The Evidence Lab, source links and illustrative walkthrough work without wallet access. The browser Evidence Lab is not an on-chain proof, and local Direct Mode tests do not replace a live multi-validator settlement or payout.

The Evidence Lab fetches public archive APIs at runtime. Its result is a browser-side comparison, not an on-chain proof. API outage, source differences and spatial resolution can affect readings. Contract tests use controlled responses; Direct Mode runs the contract's evidence/consensus lifecycle against controlled responses and do not replace a live payout transaction.
