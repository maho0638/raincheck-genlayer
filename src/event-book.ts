import { buildForecastUrl } from "./forecast.ts";

export const EVENT_BOOK_KEY = "raincheck:event-book:v1";
export const MAX_SAVED_EVENTS = 20;

export type SavedEvent = {
  id: string;
  title: string;
  location: string;
  latitude: number;
  longitude: number;
  eventDate: string;
  thresholdMm: number;
  createdAt: string;
  checkedAt: string | null;
  expectedRainMm: number | null;
  thresholdLoadPercent: number | null;
  maxProbabilityPercent: number | null;
  lastError: string | null;
};

export type NewSavedEvent = Omit<SavedEvent, "checkedAt" | "expectedRainMm" | "thresholdLoadPercent" | "maxProbabilityPercent" | "lastError">;

function validTimestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

function validDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function createSavedEvent(events: SavedEvent[], input: NewSavedEvent): SavedEvent[] {
  const title = input.title.trim();
  const location = input.location.trim();
  if (!input.id || input.id.length > 80) throw new TypeError("Event ID is invalid.");
  if (!title || title.length > 80) throw new TypeError("Enter an event name up to 80 characters.");
  if (!location || location.length > 160) throw new TypeError("Choose a valid event location.");
  if (!validDate(input.eventDate)) throw new TypeError("Choose a real event date.");
  if (!Number.isFinite(input.latitude) || input.latitude < -90 || input.latitude > 90) throw new RangeError("Latitude is outside valid bounds.");
  if (!Number.isFinite(input.longitude) || input.longitude < -180 || input.longitude > 180) throw new RangeError("Longitude is outside valid bounds.");
  if (!Number.isFinite(input.thresholdMm) || input.thresholdMm < 1 || input.thresholdMm > 150) throw new RangeError("Rainfall trigger must be between 1 and 150 mm.");
  if (!validTimestamp(input.createdAt)) throw new TypeError("Event timestamp is invalid.");
  buildForecastUrl(input.latitude, input.longitude, input.eventDate);
  const duplicate = events.some((event) => event.title.toLocaleLowerCase() === title.toLocaleLowerCase()
    && event.eventDate === input.eventDate && Math.abs(event.latitude - input.latitude) < 0.0001
    && Math.abs(event.longitude - input.longitude) < 0.0001);
  if (duplicate) throw new Error("This event is already in your watchlist.");
  if (events.length >= MAX_SAVED_EVENTS) throw new Error(`Your local watchlist is full (${MAX_SAVED_EVENTS} events).`);
  return [{ ...input, title, location, checkedAt: null, expectedRainMm: null, thresholdLoadPercent: null, maxProbabilityPercent: null, lastError: null }, ...events];
}

function parseSavedEvent(value: unknown): SavedEvent | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  if (typeof row.id !== "string" || !row.id || row.id.length > 80) return null;
  if (typeof row.title !== "string" || !row.title.trim() || row.title.length > 80) return null;
  if (typeof row.location !== "string" || !row.location.trim() || row.location.length > 160) return null;
  if (typeof row.latitude !== "number" || !Number.isFinite(row.latitude) || row.latitude < -90 || row.latitude > 90) return null;
  if (typeof row.longitude !== "number" || !Number.isFinite(row.longitude) || row.longitude < -180 || row.longitude > 180) return null;
  if (!validDate(row.eventDate) || typeof row.thresholdMm !== "number" || !Number.isFinite(row.thresholdMm) || row.thresholdMm < 1 || row.thresholdMm > 150) return null;
  if (!validTimestamp(row.createdAt)) return null;
  if (row.checkedAt !== null && !validTimestamp(row.checkedAt)) return null;
  const numberOrNull = (item: unknown) => item === null || (typeof item === "number" && Number.isFinite(item) && item >= 0) ? item as number | null : null;
  const maxProbability = numberOrNull(row.maxProbabilityPercent);
  return {
    id: row.id, title: row.title, location: row.location, latitude: row.latitude, longitude: row.longitude,
    eventDate: row.eventDate, thresholdMm: row.thresholdMm, createdAt: row.createdAt,
    checkedAt: row.checkedAt as string | null,
    expectedRainMm: numberOrNull(row.expectedRainMm), thresholdLoadPercent: numberOrNull(row.thresholdLoadPercent),
    maxProbabilityPercent: maxProbability !== null && maxProbability <= 100 ? maxProbability : null,
    lastError: typeof row.lastError === "string" ? row.lastError.slice(0, 300) : null,
  };
}

export function readEventBook(storage: Pick<Storage, "getItem">): SavedEvent[] {
  try {
    const raw = storage.getItem(EVENT_BOOK_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.map(parseSavedEvent).filter((event): event is SavedEvent => event !== null).slice(0, MAX_SAVED_EVENTS);
  } catch {
    return [];
  }
}

export function writeEventBook(storage: Pick<Storage, "setItem">, events: SavedEvent[]): void {
  if (events.length > MAX_SAVED_EVENTS) throw new RangeError(`Watchlist cannot exceed ${MAX_SAVED_EVENTS} events.`);
  storage.setItem(EVENT_BOOK_KEY, JSON.stringify(events));
}

export function updateSavedEvent(events: SavedEvent[], id: string, update: Partial<Pick<SavedEvent, "checkedAt" | "expectedRainMm" | "thresholdLoadPercent" | "maxProbabilityPercent" | "lastError">>): SavedEvent[] {
  return events.map((event) => event.id === id ? { ...event, ...update } : event);
}

function csvCell(value: string | number | null) {
  let raw = value === null ? "" : String(value);
  if (typeof value === "string" && /^[=+@\-\t\r]/.test(raw)) raw = `'${raw}`;
  return `"${raw.replaceAll('"', '""')}"`;
}

export function eventBookCsv(events: SavedEvent[]): string {
  const rows = [
    ["Event", "Location", "Event date (UTC)", "Rain trigger (mm)", "Forecast rain (mm)", "Trigger load (%)", "Highest hourly rain chance (%)", "Last checked (UTC)", "Forecast source", "Limitations"],
    ...events.map((event) => [event.title, event.location, event.eventDate, event.thresholdMm, event.expectedRainMm, event.thresholdLoadPercent, event.maxProbabilityPercent, event.checkedAt, "Open-Meteo", "Planning forecast only; not contract evidence or a payout promise"]),
  ];
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(",")).join("\r\n")}`;
}
