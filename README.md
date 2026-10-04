# RainCheck Protocol

RainCheck is a GenLayer Studionet prototype for rainfall-triggered micro-cover. Before an event, a cover fixes a location, UTC day, rainfall threshold, premium and capped payout. After the day ends, the Intelligent Contract retrieves rainfall evidence from Open-Meteo Archive and NASA POWER. GenLayer validator consensus checks the evidence and the contract applies the agreed rule: approve a matching trigger, reject a non-trigger, pause when sources disagree, or leave missing evidence retryable.

## Product flow

- **Read-only Evidence Lab:** Fetches archived values for a chosen past day from both public APIs in the browser. The comparison is labeled as a local preview and never submits a transaction.
- **Contract explorer:** The page reads the deployed Studionet contract reserve and cover records without a wallet.
- **Wallet writes:** Paused on this deployment. The currently deployed contract has no reserve withdrawal function and the available reserve cannot cover a new maximum payout. The UI blocks wallet connection, new cover creation, pool funding and contract writes. Do not send funds to the old contract. Re-enable writes only after reviewing and deploying a new contract with a safe funding and withdrawal design.
- **Sample walkthrough:** Clearly illustrative and labeled; it is not represented as a real contract record.

## Contract rule

`contracts/rain_check.py` stores fixed cover terms and uses a 0.002 GEN test premium with a 0.010 GEN maximum payout. Open-Meteo is the primary trigger source and NASA POWER corroborates it. A source conflict enters `SOURCE_REVIEW`; the owner can request a premium refund. Missing data stays retryable. If both sources confirm rainfall below the threshold, the reserved payout is released. These testnet values have no real-world value; this is not an insurance product.

## Run and test

```bash
npm install
npm run check
python -m unittest discover -s tests -p 'test*.py' -v
python -m py_compile contracts/rain_check.py
python tests/run_direct_vm.py
genvm-lint check contracts/rain_check.py
```

`npm run check` runs browser logic tests and the Vite production build. The Python unit tests cover reserve accounting and settlement outcomes. Direct Mode exercises the contract against mocked weather responses and validator results. `genvm-lint check` runs both GenVM safety checks and SDK semantic validation; the linter needs a writable artifact cache and network access on its first run.

## Submission guide

See [`docs/SUBMISSION.md`](docs/SUBMISSION.md) for a concise reviewer description, demo path and current readiness limits.
