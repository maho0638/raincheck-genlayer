export type RainDecision = "APPROVED" | "NO_TRIGGER" | "SOURCE_REVIEW" | "DATA_UNAVAILABLE";

export function decideRainfall(primaryMm: number | null, corroboratingMm: number | null, thresholdMm: number): RainDecision {
  if (!Number.isFinite(thresholdMm) || thresholdMm < 1 || thresholdMm > 150) {
    throw new RangeError("Rainfall threshold must be between 1 and 150 mm.");
  }
  if (primaryMm === null || !Number.isFinite(primaryMm) || primaryMm < 0) return "DATA_UNAVAILABLE";
  if (corroboratingMm === null || !Number.isFinite(corroboratingMm) || corroboratingMm < 0) return "DATA_UNAVAILABLE";
  const primaryTriggered = primaryMm >= thresholdMm;
  const supportTriggered = corroboratingMm >= thresholdMm;
  if (primaryTriggered !== supportTriggered) return "SOURCE_REVIEW";
  return primaryTriggered ? "APPROVED" : "NO_TRIGGER";
}

export function formatRain(value: number | null): string {
  return value === null || !Number.isFinite(value) ? "No data" : `${value.toFixed(1)} mm`;
}

export function buildSourceUrls(latitude: number, longitude: number, date: string) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new RangeError("Latitude is outside valid bounds.");
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new RangeError("Longitude is outside valid bounds.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new TypeError("Date must use YYYY-MM-DD format.");
  const parsedDate = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date) throw new TypeError("Date is not a real calendar day.");
  const params = new URLSearchParams({
    latitude: latitude.toFixed(4), longitude: longitude.toFixed(4),
    start_date: date, end_date: date, daily: "precipitation_sum", timezone: "UTC",
  });
  const power = new URLSearchParams({
    parameters: "PRECTOTCORR", community: "AG", longitude: longitude.toFixed(4),
    latitude: latitude.toFixed(4), start: date.replaceAll("-", ""), end: date.replaceAll("-", ""), format: "JSON",
  });
  return {
    primary: `https://archive-api.open-meteo.com/v1/archive?${params.toString()}`,
    corroborating: `https://power.larc.nasa.gov/api/temporal/daily/point?${power.toString()}`,
  };
}
