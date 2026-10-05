import type { createClient } from "genlayer-js";
import type { CalldataEncodable } from "genlayer-js/types";
import { buildSourceUrls, decideRainfall, formatRain } from "./weather";
import { fetchRainEvidence } from "./evidence";
import { createAuditBundle, downloadAuditBundle, type AuditSnapshot } from "./audit";
import { fetchDayForecast, forecastGuidance, type DayForecast } from "./forecast";
import { searchPlaces, type Place } from "./places";
import { createSavedEvent, eventBookCsv, EVENT_BOOK_KEY, readEventBook, updateSavedEvent, writeEventBook, type SavedEvent } from "./event-book";
import "./style.css";

declare global { interface Window { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } } }

const DEPLOYED_CONTRACT_ADDRESS = "0xE25Cb5C035C7E0ae04C5Aa88aB673875bd5F20Ce";
const LEGACY_CONTRACT_ADDRESS = "0xb94D1922362B0Ac6936e908DF677aC89D05dFC51";
// Production must stay pinned to the V2 contract verified on Studionet.
// A stale VITE_CONTRACT_ADDRESS in Vercel can silently route users to the legacy contract.
const CONTRACT_ADDRESS = DEPLOYED_CONTRACT_ADDRESS;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $("cover-form") as HTMLFormElement;
const dateInput = $("event-date") as HTMLInputElement;
const thresholdInput = $("threshold") as HTMLInputElement;
const latitudeInput = $("latitude") as HTMLInputElement;
const longitudeInput = $("longitude") as HTMLInputElement;
const activityRows = $("activity-rows");
const emptyActivity = $("empty-activity");
const walletLabel = $("wallet-label");
const toast = $("toast");
const demoDialog = $("demo-dialog") as HTMLDialogElement;
let connectedAddress = "";
type GenLayerSDK = { createClient: typeof createClient; studionet: (typeof import("genlayer-js/chains"))["studionet"]; ExecutionResult: (typeof import("genlayer-js/types"))["ExecutionResult"]; TransactionStatus: (typeof import("genlayer-js/types"))["TransactionStatus"] };
let loadedGenLayerSDK: GenLayerSDK | undefined;
let readClient: ReturnType<typeof createClient> | undefined;
let walletClient: ReturnType<typeof createClient> | undefined;
let toastTimer = 0;
let demoAdded = false;
let availableReserve: bigint | null = null;
let verifiedV2 = false;
let contractOwner = "";
let refreshInProgress = false;
let lastSuccessfulRefresh = "";
let contractReadState: "checking" | "live" | "stale" | "unavailable" = "checking";
const MIN_AVAILABLE_FOR_COVER = 8_000_000_000_000_000n;

type Activity = { title: string; location: string; date: string; threshold: number; status: string; payout: string; sample?: boolean; coverId?: number; audit?: AuditSnapshot };
const activities: Activity[] = [];
let latestLabEvidence: Awaited<ReturnType<typeof fetchRainEvidence>> | null = null;
let latestForecast: DayForecast | null = null;
let latestForecastLocation = "";
let forecastInProgress = false;
let resolvedLocationLabel = "Istanbul, Türkiye";
function loadEventBook() {
  try { return readEventBook(window.localStorage); }
  catch { return []; }
}

async function loadGenLayerSDK(): Promise<GenLayerSDK> {
  if (!loadedGenLayerSDK) {
    const [client, chains, types] = await Promise.all([
      import("genlayer-js"), import("genlayer-js/chains"), import("genlayer-js/types"),
    ]);
    loadedGenLayerSDK = { createClient: client.createClient, studionet: chains.studionet, ExecutionResult: types.ExecutionResult, TransactionStatus: types.TransactionStatus };
  }
  return loadedGenLayerSDK;
}

let savedEvents: SavedEvent[] = loadEventBook();
let watchlistRefreshInProgress = false;

function showToast(message: string, kind: "success" | "error" | "info" = "info") {
  toast.textContent = message;
  toast.dataset.kind = kind;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 4200);
}

function setDateLimits() {
  const now = new Date();
  const tomorrow = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1));
  const max = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 90));
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  dateInput.min = iso(tomorrow);
  dateInput.max = iso(max);
  dateInput.value = iso(tomorrow);
}

function updateThreshold() {
  $("threshold-label").textContent = thresholdInput.value;
  $("rule-threshold").textContent = `${thresholdInput.value} mm`;
  syncPlannerInputs();
}

function syncPlannerInputs(invalidate = true) {
  const latitude = Number(latitudeInput.value);
  const longitude = Number(longitudeInput.value);
  const isLocationResolved = formatLocation() === resolvedLocationLabel;
  $("planner-location").textContent = formatLocation();
  $("planner-coordinates").textContent = !isLocationResolved
    ? "Find and select a place, or edit its coordinates"
    : Number.isFinite(latitude) && Number.isFinite(longitude)
    ? `${latitude.toFixed(4)}° ${latitude >= 0 ? "N" : "S"}, ${Math.abs(longitude).toFixed(4)}° ${longitude >= 0 ? "E" : "W"}`
    : "Coordinates need attention";
  ($("run-forecast") as HTMLButtonElement).disabled = !isLocationResolved || forecastInProgress;
  const date = dateInput.value;
  const parsed = date ? new Date(`${date}T00:00:00.000Z`) : null;
  $("planner-date").textContent = parsed && !Number.isNaN(parsed.getTime())
    ? parsed.toLocaleDateString(undefined, { weekday: "short", year: "numeric", month: "short", day: "numeric", timeZone: "UTC" })
    : "Choose an event day";
  $("planner-threshold").textContent = `${thresholdInput.value} mm`;
  if (invalidate && latestForecast && (latestForecast.eventDate !== date || latestForecast.latitude !== latitude || latestForecast.longitude !== longitude || latestForecast.thresholdMm !== Number(thresholdInput.value) || latestForecastLocation !== formatLocation())) {
    latestForecast = null;
    latestForecastLocation = "";
    $("forecast-result").classList.add("hidden");
    $("forecast-status").textContent = "Your event details changed. Check the outlook again to refresh the decision brief.";
  }
}

function renderForecast(forecast: DayForecast) {
  const guide = forecastGuidance(forecast.thresholdLoadPercent);
  $("forecast-total").textContent = formatRain(forecast.expectedRainMm);
  $("forecast-source-meta").textContent = `${new Date(forecast.retrievedAt).toLocaleString()} · ${forecast.hours.length} hourly readings · UTC`;
  $("forecast-load-label").textContent = `${forecast.thresholdLoadPercent.toFixed(0)}%`;
  $("forecast-load-bar").style.width = `${Math.min(100, forecast.thresholdLoadPercent)}%`;
  $("forecast-load-note").textContent = forecast.thresholdLoadPercent >= 100
    ? `At or above the ${forecast.thresholdMm} mm trigger in the forecast.`
    : `Below the ${forecast.thresholdMm} mm trigger in the forecast.`;
  $("forecast-action").dataset.band = guide.band;
  $("forecast-action-title").textContent = guide.title;
  $("forecast-action-copy").textContent = guide.action;
  $("forecast-peak").textContent = forecast.peakHour
    ? `${forecast.peakHour.time.slice(11, 16)} · ${formatRain(forecast.peakHour.precipitationMm)}`
    : "No hourly peak available";
  $("forecast-probability").textContent = forecast.maxProbabilityPercent === null
    ? "Hourly rain chance unavailable"
    : `Highest hourly precipitation chance: ${forecast.maxProbabilityPercent}%`;
  const grid = $("hourly-grid");
  grid.replaceChildren();
  for (const hour of forecast.hours) {
    const card = document.createElement("article");
    card.className = `hourly-card${hour.precipitationMm > 0 ? " wet" : ""}`;
    const time = document.createElement("span"); time.textContent = hour.time.slice(11, 16);
    const amount = document.createElement("b"); amount.textContent = formatRain(hour.precipitationMm);
    const probability = document.createElement("small"); probability.textContent = hour.precipitationProbability === null ? "chance n/a" : `${hour.precipitationProbability}% chance`;
    card.append(time, amount, probability);
    grid.append(card);
  }
  const dateOptions = $("date-options");
  dateOptions.replaceChildren();
  if (!forecast.alternatives.length) {
    const noOptions = document.createElement("small");
    noOptions.className = "no-date-options";
    noOptions.textContent = "No later forecast dates are available in this window.";
    dateOptions.append(noOptions);
  }
  for (const option of forecast.alternatives) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "date-option";
    button.dataset.date = option.eventDate;
    const date = document.createElement("b");
    date.textContent = new Date(`${option.eventDate}T00:00:00Z`).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
    const rain = document.createElement("span"); rain.textContent = formatRain(option.expectedRainMm);
    const load = document.createElement("small"); load.textContent = `${option.thresholdLoadPercent.toFixed(0)}% of trigger`;
    const action = document.createElement("i"); action.textContent = "Use this date";
    button.append(date, rain, load, action);
    dateOptions.append(button);
  }
  $("forecast-result").classList.remove("hidden");
}

async function checkForecast() {
  if (forecastInProgress) return;
  const button = $("run-forecast") as HTMLButtonElement;
  const status = $("forecast-status");
  forecastInProgress = true;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = "Loading forecast…";
  latestForecast = null;
  latestForecastLocation = "";
  $("forecast-result").classList.add("hidden");
  status.textContent = "Requesting the latest hourly forecast for your event day…";
  try {
    if (formatLocation() !== resolvedLocationLabel) throw new Error("Resolve the event place before checking its forecast.");
    const request = { latitude: Number(latitudeInput.value), longitude: Number(longitudeInput.value), eventDate: dateInput.value, thresholdMm: Number(thresholdInput.value), location: formatLocation() };
    const forecast = await fetchDayForecast(request.latitude, request.longitude, request.eventDate, request.thresholdMm);
    if (request.latitude !== Number(latitudeInput.value) || request.longitude !== Number(longitudeInput.value) || request.eventDate !== dateInput.value || request.thresholdMm !== Number(thresholdInput.value) || request.location !== formatLocation()) {
      status.textContent = "Event details changed while loading. Check the outlook again for the updated place, day and trigger.";
      return;
    }
    latestForecast = forecast;
    latestForecastLocation = request.location;
    renderForecast(forecast);
    status.textContent = "Forecast ready. This is planning information only; it is not a chain verdict or payout.";
  } catch (error) {
    status.textContent = error instanceof Error ? error.message : "Could not retrieve the event forecast.";
  } finally {
    forecastInProgress = false;
    button.disabled = formatLocation() !== resolvedLocationLabel;
    button.removeAttribute("aria-busy");
    button.textContent = "Check event outlook";
  }
}

function downloadForecastBrief() {
  if (!latestForecast) return;
  const guidance = forecastGuidance(latestForecast.thresholdLoadPercent);
  const brief = {
    product: "RainCheck event weather brief",
    boundary: "Forecast only. Not a GenLayer validator verdict, on-chain evidence, insurance advice, or promised payout.",
    event: { location: latestForecastLocation, latitude: latestForecast.latitude, longitude: latestForecast.longitude, dateUtc: latestForecast.eventDate, rainfallTriggerMm: latestForecast.thresholdMm },
    outlook: { expectedRainMm: latestForecast.expectedRainMm, triggerLoadPercent: latestForecast.thresholdLoadPercent, highestHourlyPrecipitationChancePercent: latestForecast.maxProbabilityPercent, wettestHourUtc: latestForecast.peakHour?.time ?? null, guidance },
    hourly: latestForecast.hours,
    lowerRainDateOptions: latestForecast.alternatives,
    retrievedAt: latestForecast.retrievedAt,
    source: { name: "Open-Meteo", url: latestForecast.sourceUrl, attribution: "Weather data from Open-Meteo, based on national weather service models." },
  };
  const blob = new Blob([JSON.stringify(brief, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `raincheck-event-brief-${latestForecast.eventDate}.json`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function saveEventBook() {
  try {
    writeEventBook(window.localStorage, savedEvents);
    return true;
  } catch {
    $("watchlist-status").textContent = "This browser could not save your event list. Check available storage or privacy settings and try again.";
    return false;
  }
}

function renderWatchlist() {
  const grid = $("watchlist-grid");
  grid.replaceChildren();
  const refresh = $("refresh-watchlist") as HTMLButtonElement;
  const exportButton = $("export-watchlist") as HTMLButtonElement;
  refresh.disabled = savedEvents.length === 0 || watchlistRefreshInProgress;
  exportButton.disabled = savedEvents.length === 0;
  if (!savedEvents.length) {
    const empty = document.createElement("div");
    empty.className = "watchlist-empty";
    empty.innerHTML = "<b>No event plans saved yet.</b><span>Choose a location, date and rain trigger above, then add your first event here.</span>";
    grid.append(empty);
    return;
  }
  const now = Date.now();
  for (const event of savedEvents) {
    const card = document.createElement("article");
    card.className = "watch-event-card";
    const top = document.createElement("div"); top.className = "watch-event-top";
    const identity = document.createElement("div");
    const title = document.createElement("h3"); title.textContent = event.title;
    const location = document.createElement("p"); location.textContent = event.location;
    identity.append(title, location);
    const date = document.createElement("span"); date.className = "watch-event-date";
    date.textContent = new Date(`${event.eventDate}T00:00:00.000Z`).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });
    top.append(identity, date);
    const metrics = document.createElement("div"); metrics.className = "watch-event-metrics";
    const forecast = document.createElement("div");
    const rain = document.createElement("b"); rain.textContent = event.expectedRainMm === null ? "Not checked" : `${formatRain(event.expectedRainMm)} forecast`;
    const trigger = document.createElement("small"); trigger.textContent = `Trigger ≥ ${event.thresholdMm} mm`;
    forecast.append(rain, trigger);
    const load = document.createElement("div");
    const loadValue = document.createElement("b"); loadValue.textContent = event.thresholdLoadPercent === null ? "—" : `${event.thresholdLoadPercent.toFixed(0)}%`;
    const loadLabel = document.createElement("small"); loadLabel.textContent = "of trigger";
    load.append(loadValue, loadLabel);
    const chance = document.createElement("div");
    const chanceValue = document.createElement("b"); chanceValue.textContent = event.maxProbabilityPercent === null ? "—" : `${event.maxProbabilityPercent}%`;
    const chanceLabel = document.createElement("small"); chanceLabel.textContent = "highest hourly chance";
    chance.append(chanceValue, chanceLabel);
    metrics.append(forecast, load, chance);
    const info = document.createElement("p"); info.className = "watch-event-info";
    if (event.lastError) info.textContent = `Could not refresh · ${event.lastError}`;
    else if (!event.checkedAt) info.textContent = "No forecast saved yet. This date may be outside the current forecast window.";
    else if (now - Date.parse(event.checkedAt) > 3 * 60 * 60 * 1000) info.textContent = `Last checked ${new Date(event.checkedAt).toLocaleString()} · outlook may have changed.`;
    else info.textContent = `Forecast checked ${new Date(event.checkedAt).toLocaleString()} · Open-Meteo`;
    const actions = document.createElement("div"); actions.className = "watch-event-actions";
    const check = document.createElement("button"); check.type = "button"; check.className = "text-control"; check.dataset.eventAction = "check"; check.dataset.eventId = event.id; check.textContent = "Refresh forecast"; check.disabled = watchlistRefreshInProgress;
    const remove = document.createElement("button"); remove.type = "button"; remove.className = "text-control remove-event"; remove.dataset.eventAction = "remove"; remove.dataset.eventId = event.id; remove.textContent = "Remove"; remove.disabled = watchlistRefreshInProgress;
    actions.append(check, remove);
    card.append(top, metrics, info, actions);
    grid.append(card);
  }
}

function saveCurrentEvent(event: SubmitEvent) {
  event.preventDefault();
  if (!form.reportValidity()) return;
  if (formatLocation() !== resolvedLocationLabel) {
    $("watchlist-status").textContent = "Search for the event city and select a result, or save valid coordinates before adding this event.";
    return;
  }
  const input = $("saved-event-title") as HTMLInputElement;
  const eventDate = dateInput.value;
  const location = formatLocation();
  const title = input.value.trim() || `${location} · ${eventDate}`;
  try {
    savedEvents = createSavedEvent(savedEvents, {
      id: globalThis.crypto?.randomUUID?.() ?? `event-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      title, location, latitude: Number(latitudeInput.value), longitude: Number(longitudeInput.value),
      eventDate, thresholdMm: Number(thresholdInput.value), createdAt: new Date().toISOString(),
    });
    const saved = savedEvents[0];
    if (latestForecast && latestForecast.eventDate === saved.eventDate && latestForecast.latitude === saved.latitude && latestForecast.longitude === saved.longitude && latestForecast.thresholdMm === saved.thresholdMm) {
      savedEvents = updateSavedEvent(savedEvents, saved.id, { checkedAt: latestForecast.retrievedAt, expectedRainMm: latestForecast.expectedRainMm, thresholdLoadPercent: latestForecast.thresholdLoadPercent, maxProbabilityPercent: latestForecast.maxProbabilityPercent });
    }
    if (!saveEventBook()) return;
    input.value = "";
    renderWatchlist();
    $("watchlist-status").textContent = `Saved “${title}” in this browser. Refresh its forecast here when you want a current outlook.`;
  } catch (error) {
    $("watchlist-status").textContent = error instanceof Error ? error.message : "Could not save this event.";
  }
}

async function refreshSavedEvent(id: string) {
  const event = savedEvents.find((item) => item.id === id);
  if (!event) return;
  try {
    const forecast = await fetchDayForecast(event.latitude, event.longitude, event.eventDate, event.thresholdMm);
    savedEvents = updateSavedEvent(savedEvents, id, {
      checkedAt: forecast.retrievedAt, expectedRainMm: forecast.expectedRainMm,
      thresholdLoadPercent: forecast.thresholdLoadPercent, maxProbabilityPercent: forecast.maxProbabilityPercent, lastError: null,
    });
  } catch (error) {
    savedEvents = updateSavedEvent(savedEvents, id, { checkedAt: new Date().toISOString(), lastError: error instanceof Error ? error.message : "Forecast refresh failed." });
  }
  saveEventBook();
  renderWatchlist();
}

async function refreshAllSavedEvents() {
  if (watchlistRefreshInProgress || !savedEvents.length) return;
  watchlistRefreshInProgress = true;
  renderWatchlist();
  const status = $("watchlist-status");
  let completed = 0;
  for (const event of [...savedEvents]) {
    completed += 1;
    status.textContent = `Refreshing event ${completed} of ${savedEvents.length}: ${event.title}…`;
    await refreshSavedEvent(event.id);
  }
  watchlistRefreshInProgress = false;
  renderWatchlist();
  const failed = savedEvents.filter((event) => event.lastError).length;
  status.textContent = failed
    ? `Updated ${savedEvents.length - failed} of ${savedEvents.length} events. ${failed} need attention; dates outside the provider’s current window can be checked later.`
    : `All ${savedEvents.length} saved event forecasts refreshed. Forecasts are planning information, not a contract decision.`;
}

function exportWatchlist() {
  if (!savedEvents.length) return;
  const blob = new Blob([eventBookCsv(savedEvents)], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `raincheck-event-portfolio-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  $("watchlist-status").textContent = "Portfolio CSV downloaded. It includes each saved event’s latest forecast and a note that forecasts are not payout decisions.";
}

function renderActivity() {
  activityRows.replaceChildren();
  emptyActivity.classList.toggle("hidden", activities.length > 0);
  const latestCoverId = Math.max(0, ...activities.filter((item) => !item.sample && item.coverId !== undefined).map((item) => item.coverId!));
  for (const item of [...activities].reverse()) {
    const row = document.createElement("div");
    row.className = "activity-row";
    const badge = item.sample ? "sample-status" : ["ACTIVE", "APPROVED"].includes(item.status) ? "active-status" : "review-status";
    let action = "";
    if (verifiedV2 && !item.sample && item.coverId) {
      if (item.status === "ACTIVE") action = canResolveEventDay(item.date)
        ? `<button class="row-action" data-action="resolve" data-id="${item.coverId}">Check claim</button>`
        : `<button class="row-action" disabled title="Available after the covered UTC day ends">Check claim after event day</button>`;
      else if (item.status === "DATA_UNAVAILABLE") action = `<button class="row-action" data-action="resolve" data-id="${item.coverId}">Retry check</button>`;
      else if (item.status === "APPROVED") action = `<button class="row-action" data-action="claim" data-id="${item.coverId}">Claim payout</button>`;
      else if (item.status === "SOURCE_REVIEW") action = `<button class="row-action" data-action="retry" data-id="${item.coverId}">Re-check</button><button class="row-action secondary" data-action="refund" data-id="${item.coverId}">Refund premium</button>`;
    }
    const auditDetails = item.audit ? `<details class="activity-audit" ${item.coverId === latestCoverId ? "open" : ""}><summary>Open the on-chain case file · evidence, rule and settlement path</summary><div class="case-file"><div class="case-status"><span>CONTRACT OUTCOME</span><b>${escapeHtml(auditDecision(item.audit))}</b></div><div class="case-sources"><a href="${escapeHtml(String((item.audit.sources as Record<string, unknown>)?.openMeteoUrl ?? "https://archive-api.open-meteo.com/"))}" target="_blank" rel="noreferrer"><span>Open-Meteo Archive <i>↗</i></span><b>${escapeHtml(auditValue(item.audit, "openMeteoMm"))}</b><small>contract-stored reading · independent source link</small></a><a href="${escapeHtml(String((item.audit.sources as Record<string, unknown>)?.nasaPowerUrl ?? "https://power.larc.nasa.gov/"))}" target="_blank" rel="noreferrer"><span>NASA POWER <i>↗</i></span><b>${escapeHtml(auditValue(item.audit, "nasaPowerMm"))}</b><small>contract-stored reading · independent source link</small></a></div><div class="case-rule"><b>Locked rule</b><span>Both sources must be ≥ ${item.threshold} mm to approve payout. Readings are saved in 0.1 mm units.</span></div>${renderCaseLifecycle(item.status)}<p>${escapeHtml(auditReason(item.status, item.threshold, item.audit))}</p><small>On-chain contract: ${escapeHtml(CONTRACT_ADDRESS)} · cover #${item.coverId}. Source links open the providers; this export is not a validator signature.</small></div><button class="audit-export" type="button" data-evidence-export="${item.coverId}">Download SHA-256 case file</button><small class="audit-export-status" id="audit-export-status-${item.coverId}" role="status"></small></details>` : "";
    row.innerHTML = `<span class="activity-place"><i>◉</i><span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.location)}${item.sample ? " · illustrative" : ""}</small></span></span><span>${escapeHtml(item.date)}</span><span>≥ ${item.threshold} mm</span><span><i class="status-pill ${badge}">${escapeHtml(statusLabel(item.status))}</i></span><span>${escapeHtml(item.payout)}${action ? `<span class="row-actions">${action}</span>` : ""}</span>${auditDetails}`;
    activityRows.append(row);
  }
  updateHeroMonitor();
}

function updateHeroMonitor() {
  const stateLabels = { checking: "Connecting to Studionet", live: "RainCheck V2 · verified", stale: "Read failed · values may be stale", unavailable: "Contract state unavailable" };
  $("hero-live-status").textContent = stateLabels[contractReadState];
  const latest = [...activities].reverse().find((item) => !item.sample && item.coverId !== undefined);
  if (!latest) {
    $("hero-case-title").textContent = contractReadState === "live" ? "No on-chain covers yet" : "Waiting for contract read";
    $("hero-case-detail").textContent = contractReadState === "live"
      ? `Contract verified · ${availableReserve === null ? "reserve unavailable" : `${(Number(availableReserve) / 1e18).toFixed(3)} GEN free reserve`}.`
      : "Cover count and reserve appear after the public Studionet read succeeds.";
    $("hero-open-reading").textContent = "Not checked";
    $("hero-nasa-reading").textContent = "Not checked";
    $("hero-evidence-stage").querySelector("small")!.textContent = "no cover to resolve";
    $("hero-settlement-stage").querySelector("small")!.textContent = "reserve remains available";
    return;
  }
  const sources = latest.audit?.sources as Record<string, unknown> | undefined;
  $("hero-case-title").textContent = `Cover #${latest.coverId} · ${statusLabel(latest.status)}`;
  $("hero-case-detail").textContent = `${latest.date} UTC · ${latest.location} · trigger ≥ ${latest.threshold} mm`;
  $("hero-open-reading").textContent = auditValue(latest.audit!, "openMeteoMm");
  $("hero-nasa-reading").textContent = auditValue(latest.audit!, "nasaPowerMm");
  $("hero-evidence-stage").querySelector("small")!.textContent = latest.status === "ACTIVE" ? "after event day" : latest.status === "DATA_UNAVAILABLE" ? "retry available" : "two readings stored";
  $("hero-settlement-stage").querySelector("small")!.textContent = latest.status === "APPROVED" ? "payout can be claimed" : latest.status === "PAID" ? "payout transferred" : latest.status === "SOURCE_REVIEW" ? "premium refund available" : latest.status === "NO_TRIGGER" ? "locked payout released" : latest.status === "REFUNDED" ? "premium returned" : "payout remains locked";
}

function statusLabel(status: string) {
  const labels: Record<string, string> = {
    ACTIVE: "Awaiting event day", DATA_UNAVAILABLE: "Evidence unavailable · retry", SOURCE_REVIEW: "Sources conflict · review", APPROVED: "Approved · payout ready", PAID: "Paid", NO_TRIGGER: "Trigger not met", REFUNDED: "Premium refunded", SAMPLE: "Illustrative sample",
  };
  return labels[status] ?? status.replaceAll("_", " ");
}

function renderCaseLifecycle(status: string) {
  const evidence = status === "ACTIVE" ? "Not checked yet" : status === "DATA_UNAVAILABLE" ? "Retryable · source data missing" : "Two source readings recorded";
  const decision = status === "ACTIVE" ? "Waiting for UTC event day" : status === "DATA_UNAVAILABLE" ? "No rainfall outcome assigned" : status === "SOURCE_REVIEW" ? "Threshold conflict · review state" : status === "APPROVED" || status === "PAID" ? "Both sources met threshold" : status === "NO_TRIGGER" ? "Both sources below threshold" : "Final contract state";
  const settlement = status === "APPROVED" ? "Cover owner can claim payout" : status === "PAID" ? "Payout transferred" : status === "SOURCE_REVIEW" ? "Cover owner can request premium refund" : status === "REFUNDED" ? "Premium returned" : status === "NO_TRIGGER" ? "Reserved payout released" : status === "DATA_UNAVAILABLE" ? "Retry evidence check" : "No settlement yet";
  const completed = status !== "ACTIVE";
  return `<ol class="case-lifecycle"><li class="done"><b>Terms locked</b><small>UTC day · location · trigger</small></li><li class="${completed ? "done" : "current"}"><b>Evidence</b><small>${escapeHtml(evidence)}</small></li><li class="${completed ? "done" : "current"}"><b>Contract result</b><small>${escapeHtml(decision)}</small></li><li class="${["PAID", "REFUNDED", "NO_TRIGGER"].includes(status) ? "done" : "current"}"><b>Settlement</b><small>${escapeHtml(settlement)}</small></li></ol>`;
}

function auditValue(snapshot: AuditSnapshot, key: "openMeteoMm" | "nasaPowerMm") {
  const sources = snapshot.sources as Record<string, unknown> | undefined;
  const value = sources?.[key];
  return typeof value === "number" ? formatRain(value) : "No validated reading recorded";
}

function auditDecision(snapshot: AuditSnapshot) {
  const decision = snapshot.decision as Record<string, unknown> | undefined;
  return String(decision?.contractStatus ?? decision?.outcome ?? "Pending").replaceAll("_", " ");
}

function auditReason(status: string, threshold: number, snapshot: AuditSnapshot) {
  const sources = snapshot.sources as Record<string, unknown> | undefined;
  const primary = sources?.openMeteoMm;
  const corroborating = sources?.nasaPowerMm;
  if (status === "ACTIVE") return "GenLayer has not resolved this cover yet. The chain record contains no rainfall measurements, so no claim outcome is implied.";
  if (status === "DATA_UNAVAILABLE") return "At least one public source did not provide a valid reading. The contract leaves the claim retryable and does not treat missing data as zero rainfall.";
  if (status === "SOURCE_REVIEW") return `The sources disagree about the ${threshold} mm threshold (Open-Meteo: ${typeof primary === "number" ? `${formatRain(primary)} mm` : "missing"}; NASA POWER: ${typeof corroborating === "number" ? `${formatRain(corroborating)} mm` : "missing"}). The contract pauses payout for review.`;
  if (["APPROVED", "PAID"].includes(status)) return `Both recorded sources met the ${threshold} mm trigger. ${status === "PAID" ? "The approved payout has been paid." : "The claim is approved and can request its capped payout."}`;
  if (status === "NO_TRIGGER") return `Both recorded sources were below the ${threshold} mm trigger; the payout reservation was released.`;
  if (status === "REFUNDED") return "The premium was refunded after the sources entered review.";
  return "The contract's current status and stored source measurements are shown above.";
}

async function exportEvidence(snapshot: AuditSnapshot, key: string, filename: string, statusElement?: HTMLElement) {
  try {
    const prior = localStorage.getItem(key);
    const bundle = await createAuditBundle(snapshot, prior);
    localStorage.setItem(key, bundle.change.fingerprint);
    downloadAuditBundle(bundle, filename);
    const message = bundle.change.changedSincePreviousExport
      ? "Evidence changed since your previous export."
      : bundle.change.previousFingerprint === null
        ? "First evidence export saved with a SHA-256 checksum."
        : "SHA-256 created; source evidence matches the previous export.";
    if (statusElement) statusElement.textContent = `${message} ${bundle.integrity.digest.slice(0, 16)}…`;
    else showToast(message, bundle.change.changedSincePreviousExport ? "info" : "success");
  } catch (error) {
    const message = error instanceof Error ? error.message : "Evidence export failed.";
    if (statusElement) statusElement.textContent = message;
    else showToast(message, "error");
  }
}

function canResolveEventDay(eventDate: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(eventDate);
  if (!match) return false;
  const [, year, month, day] = match;
  const eventDayUtc = Date.UTC(Number(year), Number(month) - 1, Number(day));
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return todayUtc > eventDayUtc;
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function openSample() { demoDialog.showModal(); }

function describeWalletError(error: unknown) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === "string" && error) return error;
  if (error && typeof error === "object") {
    const value = error as { message?: unknown; shortMessage?: unknown; reason?: unknown; code?: unknown; data?: { message?: unknown; originalError?: { message?: unknown } } };
    for (const message of [value.shortMessage, value.message, value.data?.originalError?.message, value.data?.message, value.reason]) {
      if (typeof message === "string" && message.trim()) return message.trim();
    }
    if (typeof value.code === "string" || typeof value.code === "number") return `Wallet request failed (code ${value.code}).`;
  }
  return "The wallet did not complete the GenLayer connection. Reopen the wallet and check its pending request.";
}

async function connectWallet() {
  if (!verifiedV2) {
    showToast("Writes unlock only after the configured contract verifies as RainCheck V2.");
    return;
  }
  if (!CONTRACT_ADDRESS) {
    showToast("Wallet actions unlock after the contract passes local checks and is deployed to Studionet.");
    return;
  }
  if (!window.ethereum) {
    showToast("MetaMask or another EIP-1193 wallet was not found.", "error");
    return;
  }
  try {
    const sdk = await loadGenLayerSDK();
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
    if (!accounts?.[0]) throw new Error("No wallet account was returned.");
    const nextAddress = accounts[0];
    const nextWalletClient = sdk.createClient({ chain: sdk.studionet, account: nextAddress as `0x${string}`, provider: window.ethereum as never });
    await nextWalletClient.connect("studionet");
    connectedAddress = nextAddress;
    walletClient = nextWalletClient;
    walletLabel.textContent = `${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)}`;
    updateAdminControls();
    showToast("Wallet connected to Studionet.", "success");
    await refreshPool();
  } catch (error) {
    connectedAddress = "";
    walletClient = undefined;
    updateAdminControls();
    showToast(`Wallet connection failed: ${describeWalletError(error)}`, "error");
  }
}

async function sendContractWrite(functionName: string, args: unknown[] = [], value = 0n) {
  if (!verifiedV2) throw new Error("Writes are disabled: the configured contract did not verify as RainCheck V2.");
  if (!walletClient || !connectedAddress || !CONTRACT_ADDRESS) throw new Error("Connect a wallet after a Studionet contract address is configured.");
    const hash = await walletClient.writeContract({
      address: CONTRACT_ADDRESS as `0x${string}`,
      functionName,
      args: args as CalldataEncodable[],
      value,
    });
    showToast("Transaction sent. Waiting for GenLayer finality…");
    const sdk = await loadGenLayerSDK();
    const receipt = await walletClient.waitForTransactionReceipt({ hash, status: sdk.TransactionStatus.FINALIZED });
    if (receipt.txExecutionResultName !== sdk.ExecutionResult.FINISHED_WITH_RETURN) {
      throw new Error(`Contract call failed: ${receipt.statusName} / ${receipt.txExecutionResultName}`);
    }
  return hash;
}

async function refreshPool(manual = false) {
  if (refreshInProgress) return;
  refreshInProgress = true;
  const button = $("refresh-activity") as HTMLButtonElement;
  const refreshStatus = $("refresh-status");
  const buttonLabel = button.querySelector("span");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  buttonLabel!.textContent = "…";
  contractReadState = "checking";
  updateHeroMonitor();
  refreshStatus.textContent = "Reading the reserve and cover records from Studionet…";
  if (!readClient || !CONTRACT_ADDRESS) {
    contractReadState = "unavailable";
    updateHeroMonitor();
    refreshStatus.textContent = "Contract connection is not initialized yet.";
    button.disabled = false;
    button.removeAttribute("aria-busy");
    buttonLabel!.textContent = "↻";
    refreshInProgress = false;
    return;
  }
  try {
    verifiedV2 = false;
    contractOwner = "";
    if (CONTRACT_ADDRESS.toLowerCase() !== LEGACY_CONTRACT_ADDRESS.toLowerCase()) {
      try {
        const version = await readClient.readContract({ address: CONTRACT_ADDRESS as `0x${string}`, functionName: "get_contract_version", args: [] });
        if (version === "raincheck-v2") {
          const owner = await readClient.readContract({ address: CONTRACT_ADDRESS as `0x${string}`, functionName: "get_owner", args: [] });
          const ownerAddress = String(owner);
          if (/^0x[0-9a-fA-F]{40}$/.test(ownerAddress)) {
            contractOwner = ownerAddress.toLowerCase();
            verifiedV2 = true;
          }
        }
      } catch { /* Unknown contracts stay read-only unless version and owner both verify. */ }
    }
    updateAdminControls();
    const [available, count] = await Promise.all([
      readClient.readContract({ address: CONTRACT_ADDRESS as `0x${string}`, functionName: "get_available_reserve", args: [] }),
      readClient.readContract({ address: CONTRACT_ADDRESS as `0x${string}`, functionName: "get_cover_count", args: [] }),
    ]);
    availableReserve = BigInt(available as bigint | number | string);
    const gen = Number(availableReserve) / 1e18;
    $("pool-stat").innerHTML = `${gen.toFixed(3)} <small>GEN</small>`;
    $("pool-card-balance").innerHTML = `${gen.toFixed(3)} <small>GEN</small>`;
    $("covers-stat").textContent = String(count);
    $("pool-progress").style.width = `${Math.max(5, Math.min(gen * 20, 100))}%`;
    updateCoverAvailability();
    $("reserve-status").textContent = availableReserve >= MIN_AVAILABLE_FOR_COVER
      ? verifiedV2 ? "V2 reserve can cover one test payout" : "Legacy reserve · writes are read-only"
      : verifiedV2 ? "V2 reserve below minimum for a new cover" : "Legacy contract · writes are read-only";
    const numericCount = Number(count);
    const coverReadLimit = Math.min(numericCount, 40);
    const coverResults = await Promise.allSettled(Array.from({ length: coverReadLimit }, (_, index) =>
      readClient!.readContract({ address: CONTRACT_ADDRESS as `0x${string}`, functionName: "get_cover", args: [BigInt(index + 1)] })
    ));
    const failedCoverReads = coverResults.filter((result) => result.status === "rejected").length;
    for (let i = activities.length - 1; i >= 0; i--) if (!activities[i].sample) activities.splice(i, 1);
    for (let i = 0; i < coverResults.length; i++) {
      const result = coverResults[i];
      if (result.status === "rejected") continue;
      const entry = result.value as Record<string, unknown>;
      if (entry.found === false) continue;
      const lat = Number(entry.latitude_e4) / 10000;
      const lon = Number(entry.longitude_e4) / 10000;
      activities.push({
        title: `Rain cover #${i + 1}`, location: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
        date: String(entry.event_date), threshold: Number(entry.threshold_mm),
        status: String(entry.status), payout: entry.status === "PAID" ? "Paid" : `${(Number(entry.payout_wei) / 1e18).toFixed(3)} GEN`, coverId: i + 1,
        audit: {
          recordType: "RainCheck on-chain cover",
          network: "GenLayer Studionet",
          contractAddress: CONTRACT_ADDRESS,
          coverId: i + 1,
          coverOwner: String(entry.owner ?? ""),
          eventDate: String(entry.event_date), latitude: lat, longitude: lon,
          thresholdMm: Number(entry.threshold_mm),
          sources: {
            openMeteoMm: Number(entry.open_meteo_mm_x10) >= 0 ? Number(entry.open_meteo_mm_x10) / 10 : null,
            nasaPowerMm: Number(entry.nasa_power_mm_x10) >= 0 ? Number(entry.nasa_power_mm_x10) / 10 : null,
            openMeteoError: Number(entry.open_meteo_mm_x10) < 0 ? "No valid on-chain measurement recorded." : null,
            nasaPowerError: Number(entry.nasa_power_mm_x10) < 0 ? "No valid on-chain measurement recorded." : null,
            openMeteoUrl: buildSourceUrls(lat, lon, String(entry.event_date)).primary,
            nasaPowerUrl: buildSourceUrls(lat, lon, String(entry.event_date)).corroborating,
          },
          decision: { contractStatus: String(entry.status), outcome: auditReason(String(entry.status), Number(entry.threshold_mm), { sources: { openMeteoMm: Number(entry.open_meteo_mm_x10) >= 0 ? Number(entry.open_meteo_mm_x10) / 10 : null, nasaPowerMm: Number(entry.nasa_power_mm_x10) >= 0 ? Number(entry.nasa_power_mm_x10) / 10 : null } }) },
          retrievedAt: new Date().toISOString(),
          evidenceBoundary: "Stored contract values are on-chain; source URLs are provided for independent review. This export is not a validator signature.",
        },
      });
    }
    contractReadState = "live";
    renderActivity();
    lastSuccessfulRefresh = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
    refreshStatus.textContent = failedCoverReads
      ? `Updated ${lastSuccessfulRefresh} · ${failedCoverReads} cover record${failedCoverReads === 1 ? "" : "s"} could not be read.`
      : `Updated ${lastSuccessfulRefresh} · reserve and ${coverReadLimit}${numericCount > coverReadLimit ? ` of ${numericCount}` : ""} cover record${numericCount === 1 ? "" : "s"} read on-chain.`;
    if (manual) showToast(failedCoverReads ? "Reserve refreshed; some cover records could not be read." : "Contract state refreshed from Studionet.", failedCoverReads ? "info" : "success");
  } catch (error) {
    // Keep the last known values visible, but disable writes until the next successful verification.
    verifiedV2 = false;
    contractReadState = lastSuccessfulRefresh ? "stale" : "unavailable";
    updateCoverAvailability();
    updateAdminControls();
    updateHeroMonitor();
    const detail = error instanceof Error ? error.message : "Unknown RPC error";
    refreshStatus.textContent = lastSuccessfulRefresh
      ? `Refresh failed · showing last successful read from ${lastSuccessfulRefresh}. ${detail}`
      : `Could not read the contract. ${detail}`;
    $("reserve-status").textContent = "Read failed · displayed values may be stale";
    if (manual) showToast(`Couldn't refresh contract state: ${detail}`, "error");
  } finally {
    refreshInProgress = false;
    button.disabled = false;
    button.removeAttribute("aria-busy");
    buttonLabel!.textContent = "↻";
  }
}

function updateCoverAvailability() {
  const button = $("create-cover") as HTMLButtonElement;
  const note = $("cover-availability");
  const canCreate = verifiedV2 && availableReserve !== null && availableReserve >= MIN_AVAILABLE_FOR_COVER;
  button.disabled = !canCreate;
  button.querySelector("span")!.textContent = canCreate ? "Activate cover" : "Cover unavailable";
  note.textContent = canCreate
    ? "Shared reserve is ready. Any connected wallet can create a cover."
    : !verifiedV2
      ? "Read-only until a RainCheck V2 contract is deployed and configured."
    : availableReserve === null
      ? "Waiting for a successful public reserve read. No transaction is sent."
      : "This contract cannot pay a new cover right now. Use the read-only Evidence Lab below.";
}

function parseUnits(value: string) {
  const [whole, fraction = ""] = value.split(".");
  if (!/^\d+$/.test(whole) || !/^\d*$/.test(fraction) || fraction.length > 18) throw new TypeError("Invalid GEN amount.");
  return BigInt(whole) * 10n ** 18n + BigInt((fraction + "0".repeat(18)).slice(0, 18));
}

function formatLocation() {
  return ($("location") as HTMLInputElement).value.trim() || `${Number(latitudeInput.value).toFixed(4)}, ${Number(longitudeInput.value).toFixed(4)}`;
}

async function activateCover(event: SubmitEvent) {
  event.preventDefault();
  const latitude = Number(latitudeInput.value);
  const longitude = Number(longitudeInput.value);
  const threshold = Number(thresholdInput.value);
  const date = dateInput.value;
  try {
    if (formatLocation() !== resolvedLocationLabel) throw new Error("Search for the event city and choose a result, or edit the coordinates, before creating a cover.");
    if (!verifiedV2) throw new Error("This contract is read-only. Deploy and configure RainCheck V2 before creating covers.");
    buildSourceUrls(latitude, longitude, date);
    if (availableReserve === null || availableReserve < MIN_AVAILABLE_FOR_COVER) {
      showToast("The deployed reserve cannot cover the 0.010 GEN payout. No transaction was sent.", "error");
      return;
    }
    if (!CONTRACT_ADDRESS) {
      showToast("The demo is ready, but no on-chain transaction was sent. Configure the tested contract after deployment.");
      return;
    }
    if (!walletClient) { await connectWallet(); if (!walletClient) return; }
    const button = $("create-cover") as HTMLButtonElement;
    button.disabled = true;
    const args = [Math.round(latitude * 10000), Math.round(longitude * 10000), date, BigInt(threshold)];
    const hash = await sendContractWrite("buy_cover", args, parseUnits("0.002"));
    activities.push({ title: `Cover ${hash.slice(0, 8)}`, location: formatLocation(), date, threshold, status: "ACTIVE", payout: "0.010 GEN" });
    renderActivity();
    await refreshPool();
    showToast("Cover activated. Terms are now linked to the transaction.", "success");
    button.disabled = false;
  } catch (error) {
    ($( "create-cover") as HTMLButtonElement).disabled = false;
    showToast(error instanceof Error ? error.message : "Could not activate this cover.", "error");
  }
}

function initializeEvidenceLab() {
  const form = $("evidence-form") as HTMLFormElement;
  const dateField = $("lab-date") as HTMLInputElement;
  const now = new Date();
  const yesterday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 1));
  const historical = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - 31));
  const iso = (date: Date) => date.toISOString().slice(0, 10);
  dateField.max = iso(yesterday);
  dateField.min = "1981-01-01";
  dateField.value = iso(historical);

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("run-evidence") as HTMLButtonElement;
    const status = $("lab-status");
    const result = $("lab-result");
    const openValue = $("lab-open-value");
    const nasaValue = $("lab-nasa-value");
    const openError = $("lab-open-error");
      const nasaError = $("lab-nasa-error");
      button.disabled = true;
      result.classList.add("hidden");
      latestLabEvidence = null;
      ($("export-lab-evidence") as HTMLButtonElement).disabled = true;
    status.textContent = "Requesting archived readings from both public sources…";
    try {
      const preview = await fetchRainEvidence(
        Number(($("lab-latitude") as HTMLInputElement).value),
        Number(($("lab-longitude") as HTMLInputElement).value),
        dateField.value,
        Number(($("lab-threshold") as HTMLInputElement).value),
      );
      latestLabEvidence = preview;
      const openLink = $("lab-open-link") as HTMLAnchorElement;
      const nasaLink = $("lab-nasa-link") as HTMLAnchorElement;
      openLink.href = preview.sourceUrls.primary;
      nasaLink.href = preview.sourceUrls.corroborating;
      openValue.textContent = formatRain(preview.openMeteoMm);
      nasaValue.textContent = formatRain(preview.nasaPowerMm);
      openError.textContent = preview.sourceErrors.openMeteo ?? "Retrieved";
      nasaError.textContent = preview.sourceErrors.nasaPower ?? "Retrieved";
      $("lab-decision-value").textContent = preview.decision.replaceAll("_", " ");
      $("lab-decision-value").dataset.decision = preview.decision.toLowerCase();
      $("lab-retrieved").textContent = `Retrieved ${new Date(preview.retrievedAt).toLocaleString()} · UTC day ${preview.eventDate}`;
      $("lab-reason").textContent = preview.decision === "APPROVED"
        ? `Both sources meet the ${preview.thresholdMm} mm trigger.`
        : preview.decision === "NO_TRIGGER"
          ? `Both sources are below the ${preview.thresholdMm} mm trigger.`
          : preview.decision === "SOURCE_REVIEW"
            ? `The sources disagree about the ${preview.thresholdMm} mm trigger; the contract would pause for review.`
            : "A valid reading is missing. Missing data is not treated as zero rainfall.";
      ($("export-lab-evidence") as HTMLButtonElement).disabled = false;
      result.classList.remove("hidden");
      status.textContent = preview.decision === "DATA_UNAVAILABLE"
        ? "At least one source did not return a valid reading. The result is unavailable, not a zero-rain verdict."
        : "Both source responses are shown below. This browser preview sent no transaction.";
    } catch (error) {
      status.textContent = error instanceof Error ? error.message : "Could not fetch archived evidence.";
    } finally {
      button.disabled = false;
    }
  });
}

async function fundPool() {
  try {
    if (!CONTRACT_ADDRESS) { showToast("Pool funding is disabled until the contract is tested and deployed to Studionet."); return; }
    if (!verifiedV2) { showToast("Funding is disabled because this contract is not verified as RainCheck V2.", "error"); return; }
    if (!walletClient) { await connectWallet(); if (!walletClient) return; }
    if (connectedAddress.toLowerCase() !== contractOwner) throw new Error("Only the verified pool owner can add test liquidity.");
    await sendContractWrite("fund_reserve", [], parseUnits(($("fund-amount") as HTMLInputElement).value));
    await refreshPool();
    showToast("Test liquidity was added to the pool.", "success");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Could not fund the pool.", "error");
  }
}

async function withdrawPool() {
  try {
    if (!verifiedV2 || !walletClient || connectedAddress.toLowerCase() !== contractOwner) {
      throw new Error("Connect the verified pool owner wallet before withdrawing free reserve.");
    }
    await sendContractWrite("withdraw_reserve", [parseUnits(($("withdraw-amount") as HTMLInputElement).value)]);
    await refreshPool();
    showToast("Free reserve returned to the pool owner.", "success");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Could not withdraw free reserve.", "error");
  }
}

function updateAdminControls() {
  const ownerConnected = Boolean(connectedAddress && contractOwner && connectedAddress.toLowerCase() === contractOwner);
  const admin = $("reserve-admin");
  admin.classList.toggle("hidden", !verifiedV2);
  const connect = $("connect-wallet") as HTMLButtonElement;
  connect.disabled = !verifiedV2;
  connect.title = verifiedV2 ? "Connect a wallet on Studionet" : "Writes unlock only for a verified RainCheck V2 contract";
  walletLabel.textContent = connectedAddress ? `${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)}` : verifiedV2 ? "Connect wallet" : "Legacy · read-only";
  $("fund-pool").toggleAttribute("disabled", !ownerConnected);
  $("withdraw-reserve").toggleAttribute("disabled", !ownerConnected);
  $("reserve-mode").textContent = verifiedV2 ? ownerConnected ? "V2 · OWNER CONNECTED" : "V2 · OWNER CONTROLS" : "LEGACY · READ ONLY";
  $("network-label").textContent = verifiedV2 ? "Studionet · RainCheck V2" : CONTRACT_ADDRESS ? "Studionet · legacy read-only" : "Studionet preview";
  document.body.dataset.mode = verifiedV2 ? "live" : "preview";
  $("pool-info-title").textContent = verifiedV2 ? "Shared pool. Owner-managed liquidity." : "Legacy reserve stays read only.";
  $("pool-info-copy").textContent = verifiedV2
    ? "Any connected wallet can create a cover while free reserve is available. Only the deployer can add or withdraw test liquidity; payouts backing active covers stay locked. Test GEN has no real-world value."
    : "This configured contract predates owner withdrawal protection. No deposits or transactions are enabled. Deploy RainCheck V2 and configure its address to activate the full flow.";
  updateCoverAvailability();
}

function showSampleInActivity() {
  if (!demoAdded) {
    activities.push({ title: "Sample · Istanbul rainfall", location: "Istanbul, Türkiye", date: "19 Sep 2026", threshold: 30, status: "SAMPLE", payout: "No token moved", sample: true });
    demoAdded = true;
    renderActivity();
  }
  demoDialog.close();
  document.getElementById("activity")?.scrollIntoView({ behavior: "smooth", block: "start" });
}

function setCoordinates(label = "Custom coordinates") {
  const latitude = Number(latitudeInput.value);
  const longitude = Number(longitudeInput.value);
  try {
    buildSourceUrls(latitude, longitude, dateInput.value);
    ($("location") as HTMLInputElement).value = label;
    resolvedLocationLabel = label;
    $("coords-label").textContent = `${latitude.toFixed(4)}° ${latitude >= 0 ? "N" : "S"}, ${Math.abs(longitude).toFixed(4)}° ${longitude >= 0 ? "E" : "W"}`;
    $("coord-inputs").classList.add("hidden");
    syncPlannerInputs();
  } catch (error) { showToast(error instanceof Error ? error.message : "Invalid coordinates.", "error"); }
}

function placeLabel(place: Place) {
  return [place.name, place.admin1, place.country].filter(Boolean).filter((part, index, all) => all.indexOf(part) === index).join(", ");
}

async function findPlaces() {
  const button = $("search-location") as HTMLButtonElement;
  const results = $("location-results");
  const query = ($("location") as HTMLInputElement).value;
  button.disabled = true;
  button.textContent = "Searching…";
  results.replaceChildren();
  try {
    const places = await searchPlaces(query);
    if (!places.length) {
      const empty = document.createElement("p");
      empty.textContent = "No matching places. Try a nearby city or edit coordinates.";
      results.append(empty);
    }
    for (const place of places) {
      const option = document.createElement("button");
      option.type = "button";
      option.className = "place-option";
      option.setAttribute("role", "option");
      option.textContent = placeLabel(place);
      option.addEventListener("click", () => {
        latitudeInput.value = place.latitude.toFixed(4);
        longitudeInput.value = place.longitude.toFixed(4);
        ($("location") as HTMLInputElement).value = placeLabel(place);
        resolvedLocationLabel = placeLabel(place);
        $("coords-label").textContent = `${place.latitude.toFixed(4)}° ${place.latitude >= 0 ? "N" : "S"}, ${Math.abs(place.longitude).toFixed(4)}° ${place.longitude >= 0 ? "E" : "W"}`;
        results.replaceChildren();
        results.classList.add("hidden");
        syncPlannerInputs();
      });
      results.append(option);
    }
    results.classList.remove("hidden");
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Place search failed.", "error");
  } finally {
    button.disabled = false;
    button.textContent = "Find place";
  }
}

async function useBrowserLocation() {
  if (!navigator.geolocation) { showToast("This browser does not support location access.", "error"); return; }
  navigator.geolocation.getCurrentPosition((position) => {
    latitudeInput.value = position.coords.latitude.toFixed(4);
    longitudeInput.value = position.coords.longitude.toFixed(4);
    setCoordinates("Browser location");
  }, () => showToast("Location permission was not granted. You can enter coordinates instead.", "error"), { enableHighAccuracy: false, timeout: 8000 });
}

function setMode() {
  if (CONTRACT_ADDRESS) {
    $("network-label").textContent = "Studionet · checking contract";
    document.body.dataset.mode = "preview";
  } else {
    $("network-label").textContent = "Studionet preview";
    document.body.dataset.mode = "preview";
  }
}

thresholdInput.addEventListener("input", updateThreshold);
form.addEventListener("submit", activateCover);
$("connect-wallet").addEventListener("click", connectWallet);
$("open-demo").addEventListener("click", openSample);
$("close-demo").addEventListener("click", () => demoDialog.close());
$("show-sample").addEventListener("click", showSampleInActivity);
$("fund-pool").addEventListener("click", fundPool);
$("withdraw-reserve").addEventListener("click", withdrawPool);
$("refresh-activity").addEventListener("click", () => { void refreshPool(true); });
$("run-forecast").addEventListener("click", () => { void checkForecast(); });
$("export-forecast").addEventListener("click", downloadForecastBrief);
$("save-event-form").addEventListener("submit", saveCurrentEvent);
$("refresh-watchlist").addEventListener("click", () => { void refreshAllSavedEvents(); });
$("export-watchlist").addEventListener("click", exportWatchlist);
$("watchlist-grid").addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-event-action]");
  if (!button?.dataset.eventId || watchlistRefreshInProgress) return;
  const { eventId, eventAction } = button.dataset;
  if (eventAction === "remove") {
    savedEvents = savedEvents.filter((item) => item.id !== eventId);
    if (saveEventBook()) {
      renderWatchlist();
      $("watchlist-status").textContent = "Event removed from this browser’s portfolio.";
    }
    return;
  }
  if (eventAction === "check") {
    watchlistRefreshInProgress = true;
    renderWatchlist();
    $("watchlist-status").textContent = "Requesting a fresh event forecast…";
    await refreshSavedEvent(eventId);
    watchlistRefreshInProgress = false;
    renderWatchlist();
    const updated = savedEvents.find((item) => item.id === eventId);
    $("watchlist-status").textContent = updated?.lastError
      ? `Forecast not refreshed: ${updated.lastError}`
      : `Forecast refreshed for ${updated?.title ?? "event"}. Planning outlook only; no payout decision was made.`;
  }
});
$("search-location").addEventListener("click", () => { void findPlaces(); });
$("location").addEventListener("input", () => syncPlannerInputs());
$("date-options").addEventListener("click", (event) => {
  const option = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-date]");
  if (!option?.dataset.date) return;
  dateInput.value = option.dataset.date;
  dateInput.dispatchEvent(new Event("change", { bubbles: true }));
  $("forecast-status").textContent = "Alternative date selected. Check the outlook again to refresh the event brief.";
});
activityRows.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const exportButton = target.closest<HTMLButtonElement>("button[data-evidence-export]");
  if (exportButton) {
    const item = activities.find((entry) => entry.coverId === Number(exportButton.dataset.evidenceExport));
    if (item?.audit) {
      const status = $(
        `audit-export-status-${item.coverId}`,
      );
      await exportEvidence(item.audit, `raincheck:cover:${item.coverId}`, `raincheck-cover-${item.coverId}-evidence.json`, status);
    }
    return;
  }
  const button = target.closest<HTMLButtonElement>("button[data-action]");
  if (!button) return;
  const coverId = Number(button.dataset.id);
  const action = button.dataset.action;
  const functionName = action === "claim" ? "claim_payout" : action === "refund" ? "refund_source_conflict" : "resolve_claim";
  button.disabled = true;
  try {
    if (!walletClient) { await connectWallet(); if (!walletClient) { button.disabled = false; return; } }
    await sendContractWrite(functionName, [BigInt(coverId)]);
    await refreshPool();
    showToast(action === "claim" ? "Payout request finalized." : action === "refund" ? "Premium refund requested." : "Evidence checked by the contract.", "success");
  } catch (error) {
    button.disabled = false;
    showToast(error instanceof Error ? error.message : "Contract action failed.", "error");
  }
});
$("export-lab-evidence").addEventListener("click", async () => {
  if (!latestLabEvidence) return;
  const evidence = latestLabEvidence;
  const snapshot: AuditSnapshot = {
    recordType: "RainCheck local Evidence Lab preview",
    network: "Browser-only public-data comparison; no transaction submitted",
    eventDate: evidence.eventDate, latitude: evidence.latitude, longitude: evidence.longitude,
    thresholdMm: evidence.thresholdMm,
    sources: {
      openMeteoMm: evidence.openMeteoMm, nasaPowerMm: evidence.nasaPowerMm,
      openMeteoError: evidence.sourceErrors.openMeteo ?? null,
      nasaPowerError: evidence.sourceErrors.nasaPower ?? null,
      openMeteoUrl: evidence.sourceUrls.primary, nasaPowerUrl: evidence.sourceUrls.corroborating,
    },
    decision: { outcome: evidence.decision, reason: $("lab-reason").textContent },
    retrievedAt: evidence.retrievedAt,
    evidenceBoundary: "This local preview is not a GenLayer validator decision or an on-chain record.",
  };
  const key = `raincheck:lab:${evidence.latitude}:${evidence.longitude}:${evidence.eventDate}:${evidence.thresholdMm}`;
  await exportEvidence(snapshot, key, `raincheck-evidence-${evidence.eventDate}.json`, $("lab-export-status"));
});
$("locate-me").addEventListener("click", useBrowserLocation);
$("edit-coords").addEventListener("click", (event) => { event.preventDefault(); $("coord-inputs").classList.toggle("hidden"); });
$("save-coords").addEventListener("click", () => setCoordinates("Custom coordinates"));
$("menu-toggle").addEventListener("click", () => document.querySelector(".main-nav")?.classList.toggle("nav-open"));
dateInput.addEventListener("change", () => { syncPlannerInputs(); try { buildSourceUrls(Number(latitudeInput.value), Number(longitudeInput.value), dateInput.value); } catch { /* Native date validation is shown on submit. */ } });

setDateLimits();
syncPlannerInputs(false);
initializeEvidenceLab();
updateThreshold();
setMode();
renderActivity();
renderWatchlist();
window.addEventListener("storage", (event) => {
  if (event.key === EVENT_BOOK_KEY) {
    savedEvents = loadEventBook();
    renderWatchlist();
  }
});
if (CONTRACT_ADDRESS) {
  void (async () => {
    try {
      const sdk = await loadGenLayerSDK();
      readClient = sdk.createClient({ chain: sdk.studionet });
      await refreshPool();
    } catch (error) {
      contractReadState = "unavailable";
      updateHeroMonitor();
      $("refresh-status").textContent = error instanceof Error ? `GenLayer client could not start: ${error.message}` : "GenLayer client could not start.";
      $("reserve-status").textContent = "Contract connection unavailable";
      updateCoverAvailability();
    }
  })();
}
