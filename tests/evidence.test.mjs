import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchRainEvidence } from "../src/evidence.ts";

const date = "2026-09-19";
const open = (value) => new Response(JSON.stringify({ daily: { time: [date], precipitation_sum: [value] } }), { status: 200 });
const nasa = (value) => new Response(JSON.stringify({ properties: { parameter: { PRECTOTCORR: { "20260919": value } } } }), { status: 200 });
function fakeFetch(openResponse, nasaResponse) {
  return async (url) => url.includes("open-meteo") ? openResponse : nasaResponse;
}

test("historical evidence applies the same threshold when both sources trigger", async () => {
  const result = await fetchRainEvidence(41.0082, 28.9784, date, 30, fakeFetch(open(34.6), nasa(32.1)), () => new Date("2026-10-04T12:00:00Z"));
  assert.equal(result.decision, "APPROVED");
  assert.equal(result.openMeteoMm, 34.6);
  assert.equal(result.nasaPowerMm, 32.1);
  assert.equal(result.retrievedAt, "2026-10-04T12:00:00.000Z");
  assert.match(result.sourceUrls.primary, /archive-api\.open-meteo\.com/);
});

test("source disagreement is visible as SOURCE_REVIEW", async () => {
  const result = await fetchRainEvidence(41.0082, 28.9784, date, 30, fakeFetch(open(34.6), nasa(22.1)));
  assert.equal(result.decision, "SOURCE_REVIEW");
});

test("two readings below the trigger return NO_TRIGGER", async () => {
  const result = await fetchRainEvidence(41.0082, 28.9784, date, 30, fakeFetch(open(12), nasa(15)));
  assert.equal(result.decision, "NO_TRIGGER");
});

test("a failed or sentinel source is DATA_UNAVAILABLE without inventing a reading", async () => {
  const result = await fetchRainEvidence(41.0082, 28.9784, date, 30, fakeFetch(open(12), new Response("offline", { status: 503 })));
  assert.equal(result.decision, "DATA_UNAVAILABLE");
  assert.equal(result.nasaPowerMm, null);
  assert.ok(result.sourceErrors.nasaPower);
});

test("threshold and coordinates are validated before any source request", async () => {
  let calls = 0;
  const fetcher = async () => { calls++; throw new Error("must not fetch"); };
  await assert.rejects(fetchRainEvidence(91, 0, date, 30, fetcher), RangeError);
  await assert.rejects(fetchRainEvidence(41, 29, date, 33, fetcher), RangeError);
  assert.equal(calls, 0);
});
