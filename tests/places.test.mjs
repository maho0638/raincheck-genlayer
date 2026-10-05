import { test } from "node:test";
import assert from "node:assert/strict";
import { searchPlaces } from "../src/places.ts";

test("place search encodes user input and returns validated results", async () => {
  let requested = "";
  const places = await searchPlaces("São Paulo", async (url) => {
    requested = String(url);
    return { ok: true, json: async () => ({ results: [
      { name: "São Paulo", admin1: "São Paulo", country: "Brazil", latitude: -23.55, longitude: -46.63 },
      { name: "Bad result", latitude: "unknown", longitude: 1 },
    ] }) };
  });
  assert.match(requested, /name=S%C3%A3o\+Paulo/);
  assert.equal(places.length, 1);
  assert.equal(places[0].latitude, -23.55);
});

test("place search requires a query and keeps provider errors actionable", async () => {
  await assert.rejects(searchPlaces("x"), /at least two letters/);
  await assert.rejects(searchPlaces("London", async () => ({ ok: false, status: 429 })), /429/);
});
