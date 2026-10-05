export type AuditSnapshot = Record<string, unknown>;

export type AuditBundle = {
  format: "raincheck-evidence-v1";
  generatedAt: string;
  snapshot: AuditSnapshot;
  integrity: { algorithm: "SHA-256"; digest: string; scope: "UTF-8 JSON.stringify(snapshot)" };
  change: { fingerprint: string; changedSincePreviousExport: boolean; previousFingerprint: string | null };
};

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function changeMaterial(snapshot: AuditSnapshot): string {
  const source = snapshot.sources as Record<string, unknown> | undefined;
  const decision = snapshot.decision as Record<string, unknown> | undefined;
  return JSON.stringify({
    eventDate: snapshot.eventDate,
    latitude: snapshot.latitude,
    longitude: snapshot.longitude,
    thresholdMm: snapshot.thresholdMm,
    primaryMm: source?.openMeteoMm,
    corroboratingMm: source?.nasaPowerMm,
    primaryError: source?.openMeteoError,
    corroboratingError: source?.nasaPowerError,
    outcome: decision?.outcome,
    contractStatus: decision?.contractStatus,
  });
}

export async function createAuditBundle(
  snapshot: AuditSnapshot,
  previousFingerprint: string | null = null,
  generatedAt = new Date().toISOString(),
): Promise<AuditBundle> {
  const [digest, fingerprint] = await Promise.all([
    sha256(JSON.stringify(snapshot)),
    sha256(changeMaterial(snapshot)),
  ]);
  return {
    format: "raincheck-evidence-v1",
    generatedAt,
    snapshot,
    integrity: { algorithm: "SHA-256", digest, scope: "UTF-8 JSON.stringify(snapshot)" },
    change: {
      fingerprint,
      changedSincePreviousExport: previousFingerprint !== null && previousFingerprint !== fingerprint,
      previousFingerprint,
    },
  };
}

export function downloadAuditBundle(bundle: AuditBundle, filename: string): void {
  const url = URL.createObjectURL(new Blob([JSON.stringify(bundle, null, 2)], { type: "application/json" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
