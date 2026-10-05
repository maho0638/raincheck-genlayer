import { readFileSync } from "node:fs";
import { test } from "node:test";
import assert from "node:assert/strict";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const main = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");

test("every literal DOM lookup in the app has one matching page element", () => {
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]);
  const uniqueIds = new Set(ids);
  assert.equal(ids.length, uniqueIds.size, "page contains duplicate element IDs");

  const references = new Set([...main.matchAll(/\$\(["']([^"']+)["']\)/g)].map((match) => match[1]));
  const missing = [...references].filter((id) => !uniqueIds.has(id));
  assert.deepEqual(missing, [], `main.ts references missing page elements: ${missing.join(", ")}`);
});

test("refresh control exposes a live status region for read progress and outcome", () => {
  assert.match(html, /id="refresh-activity"/);
  assert.match(html, /id="refresh-status" role="status" aria-live="polite"/);
  assert.match(main, /addEventListener\("click", \(\) => \{ void refreshPool\(true\); \}\)/);
});

test("event planner exposes location, forecast, result and honest commercial boundaries", () => {
  assert.match(html, /id="planner"/);
  assert.match(html, /id="search-location"/);
  assert.match(html, /id="run-forecast"/);
  assert.match(html, /id="hourly-grid"/);
  assert.match(html, /id="date-options"/);
  assert.match(html, /id="export-forecast"/);
  assert.match(html, /commercial use requires its commercial-use licence/i);
  assert.match(main, /request\.location !== formatLocation\(\)/);
  assert.match(main, /Forecast only\. Not a GenLayer validator verdict/);
});

test("event portfolio exposes local persistence, manual refresh, duplicate protection and safe CSV export", () => {
  assert.match(html, /id="watchlist"/);
  assert.match(html, /id="save-event-form"/);
  assert.match(html, /id="refresh-watchlist"/);
  assert.match(html, /id="export-watchlist"/);
  assert.match(html, /not checked in the background/i);
  assert.match(main, /form\.reportValidity\(\)/);
  assert.match(main, /formatLocation\(\) !== resolvedLocationLabel/);
  assert.match(main, /await refreshSavedEvent\(event\.id\)/);
  assert.match(main, /eventBookCsv\(savedEvents\)/);
});
