# RainCheck Protocol

RainCheck is a Studionet prototype for weather-triggered micro-cover. A user agrees to a location, UTC day and rainfall threshold before the event. After the day ends, the Intelligent Contract reads compact daily-rainfall evidence from Open-Meteo Archive and NASA POWER. GenLayer validators independently re-check those public values; the contract applies the fixed threshold and either approves a capped payout, rejects the trigger, pauses on a source conflict, or permits a premium refund.

## What is implemented

- Responsive product interface with an explicit sample walkthrough and no fabricated on-chain results.
- GenLayer Intelligent Contract with a liquidity reserve, fixed 0.002 GEN test premium, fixed 0.010 GEN maximum payout, date and coordinate bounds, evidence comparison, payout, and conflict refund.
- TypeScript browser client using the official `genlayer-js` SDK. Wallet actions remain locked until a contract address is configured.
- Unit coverage for decision boundaries, missing sources, source conflicts, reserve accounting, refunds and one-time payouts.

## Run locally

```bash
npm install
npm test
npm run build
python -m pip install -r requirements-dev.txt
python tests/run_direct_vm.py
genvm-lint check contracts/rain_check.py
```

The current Studionet contract address is configured in `.env.example` and as a safe frontend fallback. Public contract state loads without a wallet. Wallet writes require a wallet connected to Studionet; use test GEN only. The current deployment is a testnet prototype, not an insurance product.

## Contract

`contracts/rain_check.py` contains the Intelligent Contract. Its source URLs and settlement rule are fixed in code. Open-Meteo is the primary payout trigger and NASA POWER is a corroborating source. If both sources disagree on whether the threshold was met, payout stops and the cover owner can reclaim the premium. If data is unavailable, the claim can be retried. If both sources agree that the threshold was not met, the reserved payout is released to the pool.

The exact premium and payout are deliberately small testnet amounts. This prototype is not an insurance product and has no mainnet value. Do not send mainnet assets. The currently deployed prototype has no reserve withdrawal function. Do not call `seed_reserve`; the web interface now blocks pool funding. A safer reserve design requires a newly deployed contract.

## Test limits

Python unit tests use a small GenLayer API shim and controlled HTTP responses to exercise accounting and settlement branches. The Direct Mode test loads the contract with GenLayer storage types and controlled web responses; its compatibility runner bridges the older `py-genlayer` contract pin to the current `genlayer-test` API. It verifies cover creation, both evidence endpoints, matching and different validator results, approval, no trigger, source conflict, premium refund, payout state, and retry after missing data. `genvm-lint check` runs VM safety and SDK semantic validation. The Direct Mode compatibility runner evaluates the validator callback locally; it does not replace live multi-validator consensus or an on-chain transfer test.

The frontend is connected to the RainCheck contract deployed on Studionet. The live interface reads the reserve and cover activity without a wallet. Creating covers, funding the pool, resolving a claim, claiming a payout, and requesting a conflict refund require a wallet signature and test GEN. Never connect a mainnet wallet or send mainnet assets to this prototype.
