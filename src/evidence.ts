import { buildSourceUrls, decideRainfall, type RainDecision } from "./weather.ts";

export type RainEvidencePreview = {
  eventDate: string;
  latitude: number;
  longitude: number;
  thresholdMm: number;
  openMeteoMm: number | null;
  nasaPowerMm: number | null;
  decision: RainDecision;
  retrievedAt: string;
  sourceUrls: { primary: string; corroborating: string };
  sourceErrors: { openMeteo?: string; nasaPower?: string };
};

type FetchLike = typeof fetch;

async function readJson(url: string, fetcher: FetchLike): Promise<unknown> {
  const response = await fetcher(url, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Source returned HTTP ${response.status}`);
  return response.json() as Promise<unknown>;
}

function finiteRainfall(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function openMeteoReading(payload: unknown, date: string): number | null {
  if (!payload || typeof payload !== "object") return null;
  const daily = (payload as { daily?: { time?: unknown; precipitation_sum?: unknown } }).daily;
  if (!daily || !Array.isArray(daily.time) || !Array.isArray(daily.precipitation_sum)) return null;
  const index = daily.time.indexOf(date);
  return index < 0 ? null : finiteRainfall(daily.precipitation_sum[index]);
}

function nasaPowerReading(payload: unknown, date: string): number | null {
  if (!payload || typeof payload !== "object") return null;
  const parameters = (payload as {
    properties?: { parameter?: { PRECTOTCORR?: Record<string, unknown> } };
  }).properties?.parameter?.PRECTOTCORR;
  if (!parameters || typeof parameters !== "object") return null;
  return finiteRainfall(parameters[date.replaceAll("-", "")]);
}

/**
 * Fetch actual historical rainfall from the same public sources used by the
 * contract. This is a local, read-only preview and never submits a transaction.
 */
export async function fetchRainEvidence(
  latitude: number,
  longitude: number,
  date: string,
  thresholdMm: number,
  fetcher: FetchLike = fetch,
  now: () => Date = () => new Date(),
): Promise<RainEvidencePreview> {
  const sourceUrls = buildSourceUrls(latitude, longitude, date);
  if (!Number.isFinite(thresholdMm) || thresholdMm < 5 || thresholdMm > 100 || thresholdMm % 5 !== 0) {
    throw new RangeError("Threshold must be 5–100 mm in 5 mm steps.");
  }

  const [openResult, nasaResult] = await Promise.allSettled([
    readJson(sourceUrls.primary, fetcher),
    readJson(sourceUrls.corroborating, fetcher),
  ]);

  const openMeteoMm = openResult.status === "fulfilled" ? openMeteoReading(openResult.value, date) : null;
  const nasaPowerMm = nasaResult.status === "fulfilled" ? nasaPowerReading(nasaResult.value, date) : null;
  const sourceErrors: RainEvidencePreview["sourceErrors"] = {};
  if (openResult.status === "rejected") sourceErrors.openMeteo = String(openResult.reason);
  else if (openMeteoMm === null) sourceErrors.openMeteo = "No valid rainfall reading for this date.";
  if (nasaResult.status === "rejected") sourceErrors.nasaPower = String(nasaResult.reason);
  else if (nasaPowerMm === null) sourceErrors.nasaPower = "No valid rainfall reading for this date.";

  return {
    eventDate: date,
    latitude,
    longitude,
    thresholdMm,
    openMeteoMm,
    nasaPowerMm,
    decision: decideRainfall(openMeteoMm, nasaPowerMm, thresholdMm),
    retrievedAt: now().toISOString(),
    sourceUrls,
    sourceErrors,
  };
}
