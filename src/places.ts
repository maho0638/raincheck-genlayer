export type Place = { name: string; admin1: string; country: string; latitude: number; longitude: number };

export async function searchPlaces(query: string, fetcher: typeof fetch = fetch): Promise<Place[]> {
  const normalized = query.trim();
  if (normalized.length < 2) throw new Error("Enter at least two letters to search for a place.");
  const url = new URL("https://geocoding-api.open-meteo.com/v1/search");
  url.search = new URLSearchParams({ name: normalized, count: "5", language: "en", format: "json" }).toString();
  const response = await fetcher(url.toString(), { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Place search failed (${response.status}). Try again.`);
  const payload = await response.json() as { results?: unknown };
  if (!Array.isArray(payload.results)) return [];
  return payload.results.flatMap((item): Place[] => {
    if (!item || typeof item !== "object") return [];
    const row = item as Record<string, unknown>;
    if (typeof row.name !== "string" || typeof row.latitude !== "number" || typeof row.longitude !== "number") return [];
    return [{ name: row.name, admin1: typeof row.admin1 === "string" ? row.admin1 : "", country: typeof row.country === "string" ? row.country : "", latitude: row.latitude, longitude: row.longitude }];
  });
}
