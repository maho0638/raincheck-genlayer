import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSourceUrls, decideRainfall, formatRain } from "../src/weather.ts";

test("rainfall trigger includes an exact threshold match", () => {
  assert.equal(decideRainfall(30, 30, 30), "APPROVED");
});

test("rainfall below threshold does not pay", () => {
  assert.equal(decideRainfall(29.9, 20, 30), "NO_TRIGGER");
});

test("conflicting sources pause settlement", () => {
  assert.equal(decideRainfall(34, 28, 30), "SOURCE_REVIEW");
});

test("missing or invalid evidence does not produce a payout", () => {
  assert.equal(decideRainfall(null, 35, 30), "DATA_UNAVAILABLE");
  assert.equal(decideRainfall(Number.NaN, 35, 30), "DATA_UNAVAILABLE");
});

test("threshold inputs are bounded", () => {
  assert.throws(() => decideRainfall(30, 30, 0), RangeError);
  assert.throws(() => decideRainfall(30, 30, 151), RangeError);
});

test("source URLs use a fixed date and coordinate encoding", () => {
  const urls = buildSourceUrls(41.0082, 28.9784, "2026-10-05");
  assert.match(urls.primary, /archive-api\.open-meteo\.com/);
  assert.match(urls.primary, /start_date=2026-10-05/);
  assert.match(urls.corroborating, /power\.larc\.nasa\.gov/);
  assert.match(urls.corroborating, /PRECTOTCORR/);
});

test("invalid locations and dates are rejected before a contract call", () => {
  assert.throws(() => buildSourceUrls(91, 0, "2026-10-05"), RangeError);
  assert.throws(() => buildSourceUrls(41, 181, "2026-10-05"), RangeError);
  assert.throws(() => buildSourceUrls(41, 29, "not-a-date"), TypeError);
});

test("rain readings are explicit when absent", () => {
  assert.equal(formatRain(null), "No data");
  assert.equal(formatRain(12.36), "12.4 mm");
});
