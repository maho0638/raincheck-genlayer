export type ForecastHour = { time: string; precipitationMm: number; precipitationProbability: number | null };
export type ForecastDateOption = { eventDate: string; expectedRainMm: number; thresholdLoadPercent: number };
export type DayForecast = {
  latitude: number; longitude: number; eventDate: string; thresholdMm: number;
  expectedRainMm: number; thresholdLoadPercent: number; maxProbabilityPercent: number | null;
  peakHour: ForecastHour | null; hours: ForecastHour[]; alternatives: ForecastDateOption[]; retrievedAt: string; sourceUrl: string;
};

export function buildForecastUrl(latitude: number, longitude: number, eventDate: string) {
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) throw new RangeError("Latitude is outside valid bounds.");
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) throw new RangeError("Longitude is outside valid bounds.");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(eventDate)) throw new TypeError("Date must use YYYY-MM-DD format.");
  const day = new Date(`${eventDate}T00:00:00.000Z`);
  if (Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== eventDate) throw new TypeError("Date is not a real calendar day.");
  const params = new URLSearchParams({
    latitude: latitude.toFixed(4), longitude: longitude.toFixed(4),
    hourly: "precipitation,precipitation_probability", daily: "precipitation_sum",
    timezone: "UTC", forecast_days: "16",
  });
  return `https://api.open-meteo.com/v1/forecast?${params.toString()}`;
}

export function parseDayForecast(payload: unknown, latitude: number, longitude: number, eventDate: string, thresholdMm: number, retrievedAt = new Date().toISOString()): DayForecast {
  if (!Number.isFinite(thresholdMm) || thresholdMm < 1 || thresholdMm > 150) throw new RangeError("Rainfall threshold must be between 1 and 150 mm.");
  if (!payload || typeof payload !== "object") throw new Error("Weather provider returned an invalid response.");
  const root = payload as Record<string, unknown>;
  const hourly = root.hourly as Record<string, unknown> | undefined;
  const times = Array.isArray(hourly?.time) ? hourly!.time as unknown[] : [];
  const rain = Array.isArray(hourly?.precipitation) ? hourly!.precipitation as unknown[] : [];
  const probability = Array.isArray(hourly?.precipitation_probability) ? hourly!.precipitation_probability as unknown[] : [];
  const hours: ForecastHour[] = [];
  for (let i = 0; i < times.length; i++) {
    if (typeof times[i] !== "string" || !(times[i] as string).startsWith(`${eventDate}T`)) continue;
    const value = rain[i];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0) continue;
    const chance = probability[i];
    hours.push({ time: times[i] as string, precipitationMm: value, precipitationProbability: typeof chance === "number" && Number.isFinite(chance) ? Math.max(0, Math.min(100, chance)) : null });
  }
  if (!hours.length) {
    const available = times.filter((value): value is string => typeof value === "string").map((value) => value.slice(0, 10)).sort();
    const first = available[0];
    const last = available.at(-1);
    const horizon = first && last ? ` Forecast window: ${first} through ${last} UTC.` : "";
    throw new Error(`No hourly forecast is available for ${eventDate}.${horizon} Recheck when the event enters the 16-day forecast window.`);
  }
  const maxProbabilities = hours.map((hour) => hour.precipitationProbability).filter((value): value is number => value !== null);
  const peakHour = hours.reduce<ForecastHour | null>((peak, item) => !peak || item.precipitationMm > peak.precipitationMm ? item : peak, null);
  const hourlyTotal = hours.reduce((total, hour) => total + hour.precipitationMm, 0);
  const daily = root.daily as Record<string, unknown> | undefined;
  const dailyTimes = Array.isArray(daily?.time) ? daily!.time as unknown[] : [];
  const dailyRain = Array.isArray(daily?.precipitation_sum) ? daily!.precipitation_sum as unknown[] : [];
  const selectedDailyIndex = dailyTimes.findIndex((day) => day === eventDate);
  const selectedDailyRain = selectedDailyIndex >= 0 ? dailyRain[selectedDailyIndex] : null;
  const expectedRainMm = typeof selectedDailyRain === "number" && Number.isFinite(selectedDailyRain) && selectedDailyRain >= 0 ? selectedDailyRain : hourlyTotal;
  const alternatives = dailyTimes.flatMap((day, index): ForecastDateOption[] => {
    const amount = dailyRain[index];
    if (typeof day !== "string" || day <= eventDate || typeof amount !== "number" || !Number.isFinite(amount) || amount < 0) return [];
    return [{ eventDate: day, expectedRainMm: amount, thresholdLoadPercent: Number((amount / thresholdMm * 100).toFixed(1)) }];
  }).sort((a, b) => a.expectedRainMm - b.expectedRainMm || a.eventDate.localeCompare(b.eventDate)).slice(0, 4);
  return {
    latitude, longitude, eventDate, thresholdMm, expectedRainMm: Number(expectedRainMm.toFixed(2)),
    thresholdLoadPercent: Number((expectedRainMm / thresholdMm * 100).toFixed(1)),
    maxProbabilityPercent: maxProbabilities.length ? Math.max(...maxProbabilities) : null,
    peakHour, hours, alternatives, retrievedAt, sourceUrl: buildForecastUrl(latitude, longitude, eventDate),
  };
}

export async function fetchDayForecast(latitude: number, longitude: number, eventDate: string, thresholdMm: number, fetcher: typeof fetch = fetch): Promise<DayForecast> {
  const sourceUrl = buildForecastUrl(latitude, longitude, eventDate);
  if (!Number.isFinite(thresholdMm) || thresholdMm < 1 || thresholdMm > 150) throw new RangeError("Rainfall threshold must be between 1 and 150 mm.");
  const response = await fetcher(sourceUrl, { headers: { Accept: "application/json" } });
  if (!response.ok) throw new Error(`Open-Meteo forecast request failed (${response.status}). Try again in a moment.`);
  const payload = await response.json() as Record<string, unknown>;
  if (payload.error === true) throw new Error(typeof payload.reason === "string" ? payload.reason : "Weather provider rejected the forecast request.");
  return parseDayForecast(payload, latitude, longitude, eventDate, thresholdMm);
}

export function forecastGuidance(loadPercent: number) {
  if (!Number.isFinite(loadPercent) || loadPercent < 0) throw new RangeError("Forecast load must be a non-negative number.");
  if (loadPercent >= 100) return { band: "trigger-level", title: "Forecast reaches your rainfall trigger", action: "Start the contingency plan now. Confirm venue, supplier and attendee fallback arrangements; recheck the forecast before making the final call." };
  if (loadPercent >= 50) return { band: "watch", title: "Forecast is approaching your trigger", action: "Confirm the covered or indoor fallback and agree who will make the go/no-go call. Recheck as the event gets closer." };
  return { band: "below-trigger", title: "Forecast is below your trigger", action: "Keep the plan in place and schedule another check closer to the event. A low forecast is not a guarantee of dry weather." };
}
