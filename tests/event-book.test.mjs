import test from "node:test";
import assert from "node:assert/strict";
import { createSavedEvent, readEventBook, writeEventBook, updateSavedEvent, eventBookCsv, EVENT_BOOK_KEY, MAX_SAVED_EVENTS } from "../src/event-book.ts";

function sample(overrides = {}) {
  return { id: "event-1", title: "Market day", location: "Istanbul, Türkiye", latitude: 41.0082, longitude: 28.9784, eventDate: "2026-10-10", thresholdMm: 30, createdAt: "2026-10-05T10:00:00.000Z", ...overrides };
}

function fakeStorage(initial = null) {
  let value = initial;
  return { getItem: (key) => key === EVENT_BOOK_KEY ? value : null, setItem: (key, next) => { if (key === EVENT_BOOK_KEY) value = next; }, value: () => value };
}

test("event watchlist saves validated plans, prevents duplicates, and enforces its size limit", () => {
  const event = createSavedEvent([], sample())[0];
  assert.equal(event.title, "Market day");
  assert.equal(event.expectedRainMm, null);
  assert.throws(() => createSavedEvent([event], sample({ id: "event-2" })), /already in your watchlist/);
  assert.throws(() => createSavedEvent([], sample({ eventDate: "2026-02-30" })), /real event date/);
  assert.throws(() => createSavedEvent([], sample({ latitude: 91 })), /Latitude/);
  assert.throws(() => createSavedEvent([], sample({ title: "   " })), /event name/);
  const full = Array.from({ length: MAX_SAVED_EVENTS }, (_, index) => createSavedEvent([], sample({ id: `event-${index}`, title: `Event ${index}` }))[0]);
  assert.throws(() => createSavedEvent(full, sample({ id: "last" })), /watchlist is full/);
});

test("saved plans survive reload and malformed storage is safely ignored", () => {
  const storage = fakeStorage();
  const event = createSavedEvent([], sample())[0];
  writeEventBook(storage, [event]);
  assert.deepEqual(readEventBook(storage), [event]);
  const corrupt = fakeStorage("{not-json");
  assert.deepEqual(readEventBook(corrupt), []);
  const partlyInvalid = fakeStorage(JSON.stringify([event, { ...event, latitude: 999 }]));
  assert.deepEqual(readEventBook(partlyInvalid), [event]);
});

test("forecast refresh updates just the matching saved event", () => {
  const first = createSavedEvent([], sample())[0];
  const second = createSavedEvent([], sample({ id: "event-2", title: "Concert", eventDate: "2026-10-11" }))[0];
  const updated = updateSavedEvent([first, second], first.id, { checkedAt: "2026-10-05T11:00:00.000Z", expectedRainMm: 12.5, thresholdLoadPercent: 41.7, maxProbabilityPercent: 85, lastError: null });
  assert.equal(updated[0].expectedRainMm, 12.5);
  assert.equal(updated[1].expectedRainMm, null);
});

test("portfolio CSV quotes user text and marks forecast limitations", () => {
  const event = createSavedEvent([], sample({ title: 'Market, "east"', location: "Park\nside" }))[0];
  const saved = updateSavedEvent([event], event.id, { expectedRainMm: 14.2, thresholdLoadPercent: 47.3, maxProbabilityPercent: 61, checkedAt: "2026-10-05T11:00:00.000Z" });
  const csv = eventBookCsv(saved);
  assert.match(csv, /"Market, ""east"""/);
  assert.match(csv, /"Park\nside"/);
  assert.match(csv, /"14.2"/);
  assert.match(csv, /not contract evidence or a payout promise/);
  const formula = createSavedEvent([], sample({ title: "=HYPERLINK(\"https://example.com\")" }))[0];
  assert.match(eventBookCsv([formula]), /"'=HYPERLINK\(""https:\/\/example\.com""\)"/);
});
