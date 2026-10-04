# RainCheck Protocol

RainCheck is a GenLayer Studionet prototype for rainfall-triggered micro-cover. Before an event, a cover fixes a location, UTC day, rainfall threshold, premium and capped payout. After the day ends, the Intelligent Contract retrieves rainfall evidence from Open-Meteo Archive and NASA POWER. GenLayer validator consensus checks the evidence and the contract applies the agreed rule: approve a matching trigger, reject a non-trigger, pause when sources disagree on whether the threshold was met, or leave missing evidence retryable.

## Product flow

- **Read-only Evidence Lab:** Fetches archived values for a chosen past day from both public APIs in the browser. The comparison is labeled as a local preview and never submits a transaction.
- **Contract explorer:** The page reads the deployed Studionet contract reserve and cover records without a wallet.
- **Wallet writes:** The legacy deployment stays read-only because its contract has no reserve withdrawal function. The production UI points to the deployed V2 contract and unlocks writes only after its version and owner verify on Studionet. V2 restricts funding and withdrawals to its deployer and caps withdrawals at free reserve after locked payouts. Do not fund the legacy address.
- **Sample walkthrough:** Clearly illustrative and labeled; it is not represented as a real contract record.

## Contract rule

`contracts/rain_check.py` (RainCheck V2) stores fixed cover terms and uses a 0.002 GEN test premium with a 0.010 GEN maximum payout. The deployer is the pool owner. Owner-only `fund_reserve` accepts at least 0.001 GEN, while `withdraw_reserve` can transfer only uncommitted liquidity (`total_reserve - locked_payouts`). Open-Meteo is the primary trigger source and NASA POWER corroborates it. A source conflict means the two sources disagree about whether the rainfall threshold was met; it enters `SOURCE_REVIEW`, and the refund returns the premium to the cover owner. Missing data stays retryable. If both sources confirm rainfall below the threshold, the reserved payout is released. These testnet values have no real-world value; this is not an insurance product.

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

See [`docs/SUBMISSION.md`](docs/SUBMISSION.md) for reviewer notes and the current Studionet release state. The production UI is pinned to the deployed V2 address so a stale Vercel environment variable cannot silently route users to the legacy contract.
