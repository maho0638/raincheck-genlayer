import { test } from "node:test";
import assert from "node:assert/strict";
import { createAuditBundle } from "../src/audit.ts";

const snapshot = (openMeteoMm) => ({
  recordType: "Evidence Lab preview",
  eventDate: "2026-09-19",
  latitude: 41.0082,
  longitude: 28.9784,
  thresholdMm: 30,
  sources: { openMeteoMm, nasaPowerMm: 32.1, openMeteoError: null, nasaPowerError: null },
  decision: { outcome: openMeteoMm >= 30 ? "APPROVED" : "SOURCE_REVIEW" },
});

test("audit export hashes the snapshot and reports the first export", async () => {
  const bundle = await createAuditBundle(snapshot(34.6), null, "2026-10-05T00:00:00.000Z");
  assert.equal(bundle.format, "raincheck-evidence-v1");
  assert.equal(bundle.integrity.algorithm, "SHA-256");
  assert.match(bundle.integrity.digest, /^[a-f0-9]{64}$/);
  assert.equal(bundle.change.changedSincePreviousExport, false);
  assert.match(bundle.change.fingerprint, /^[a-f0-9]{64}$/);
});

test("audit change detection ignores export time but catches changed readings", async () => {
  const original = await createAuditBundle(snapshot(34.6), null, "2026-10-05T00:00:00.000Z");
  const sameReading = await createAuditBundle(snapshot(34.6), original.change.fingerprint, "2026-10-06T00:00:00.000Z");
  const changedReading = await createAuditBundle(snapshot(22.1), original.change.fingerprint, "2026-10-06T00:00:00.000Z");
  assert.equal(sameReading.change.changedSincePreviousExport, false);
  assert.equal(changedReading.change.changedSincePreviousExport, true);
  assert.notEqual(changedReading.integrity.digest, original.integrity.digest);
});
