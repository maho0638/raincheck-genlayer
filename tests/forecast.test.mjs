import { test } from "node:test";
import assert from "node:assert/strict";
import { buildForecastUrl, fetchDayForecast, forecastGuidance, parseDayForecast } from "../src/forecast.ts";

const fixture = {
  hourly: {
    time: ["2026-10-06T00:00", "2026-10-06T01:00", "2026-10-07T00:00"],
    precipitation: [2.4, 3.1, 90], precipitation_probability: [20, 85, 99],
  },
  daily: { time: ["2026-10-06", "2026-10-07", "2026-10-08"], precipitation_sum: [5.4, 3.3, 9.1] },
};

test("forecast request is fixed to Open-Meteo, UTC and the 16-day horizon", () => {
  const url = new URL(buildForecastUrl(41.0082, 28.9784, "2026-10-06"));
  assert.equal(url.origin, "https://api.open-meteo.com");
  assert.equal(url.searchParams.get("timezone"), "UTC");
  assert.equal(url.searchParams.get("forecast_days"), "16");
  assert.equal(url.searchParams.get("hourly"), "precipitation,precipitation_probability");
});

test("forecast aggregates only the selected UTC day and finds the wettest hour", () => {
  const result = parseDayForecast(fixture, 41.0082, 28.9784, "2026-10-06", 10, "2026-10-05T12:00:00Z");
  assert.equal(result.expectedRainMm, 5.4);
  assert.equal(result.thresholdLoadPercent, 54);
  assert.equal(result.hours.length, 2);
  assert.equal(result.peakHour?.time, "2026-10-06T01:00");
  assert.equal(result.maxProbabilityPercent, 85);
  assert.deepEqual(result.alternatives.map((option) => option.eventDate), ["2026-10-07", "2026-10-08"]);
  assert.equal(result.alternatives[0].expectedRainMm, 3.3);
});

test("forecast explicitly reports dates outside the returned horizon", () => {
  assert.throws(() => parseDayForecast(fixture, 41, 29, "2026-10-08", 30), /No hourly forecast is available.*2026-10-06 through 2026-10-07 UTC/);
});

test("forecast coordinates, calendar days and rainfall trigger are bounded", () => {
  assert.throws(() => buildForecastUrl(91, 0, "2026-10-06"), RangeError);
  assert.throws(() => buildForecastUrl(41, 29, "2026-02-30"), TypeError);
  assert.throws(() => parseDayForecast(fixture, 41, 29, "2026-10-06", 0), RangeError);
});

test("event guidance follows the stated trigger load bands", () => {
  assert.equal(forecastGuidance(49).band, "below-trigger");
  assert.equal(forecastGuidance(50).band, "watch");
  assert.equal(forecastGuidance(100).band, "trigger-level");
  assert.match(forecastGuidance(10).action, /not a guarantee/);
});

test("provider/network errors remain visible to the caller", async () => {
  await assert.rejects(fetchDayForecast(41, 29, "2026-10-06", 30, async () => ({ ok: false, status: 503 })), /503/);
  await assert.rejects(fetchDayForecast(41, 29, "2026-10-06", 30, async () => ({ ok: true, json: async () => ({ error: true, reason: "Bad coordinates" }) })), /Bad coordinates/);
});
