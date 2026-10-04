import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { ExecutionResult, TransactionStatus, type CalldataEncodable } from "genlayer-js/types";
import { buildSourceUrls, decideRainfall, formatRain } from "./weather";
import "./style.css";

declare global { interface Window { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } } }

const DEPLOYED_CONTRACT_ADDRESS = "0xb94D1922362B0Ac6936e908DF677aC89D05dFC51";
const CONTRACT_ADDRESS = (import.meta.env.VITE_CONTRACT_ADDRESS || DEPLOYED_CONTRACT_ADDRESS).trim();
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
let readClient: ReturnType<typeof createClient> | undefined;
let walletClient: ReturnType<typeof createClient> | undefined;
let toastTimer = 0;
let demoAdded = false;

type Activity = { title: string; location: string; date: string; threshold: number; status: string; payout: string; sample?: boolean; coverId?: number };
const activities: Activity[] = [];

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
}

function renderActivity() {
  activityRows.replaceChildren();
  emptyActivity.classList.toggle("hidden", activities.length > 0);
  for (const item of [...activities].reverse()) {
    const row = document.createElement("div");
    row.className = "activity-row";
    const badge = item.sample ? "sample-status" : ["ACTIVE", "APPROVED"].includes(item.status) ? "active-status" : "review-status";
    let action = "";
    if (!item.sample && item.coverId) {
      if (["ACTIVE", "DATA_UNAVAILABLE"].includes(item.status)) action = `<button class="row-action" data-action="resolve" data-id="${item.coverId}">Check claim</button>`;
      else if (item.status === "APPROVED") action = `<button class="row-action" data-action="claim" data-id="${item.coverId}">Claim payout</button>`;
      else if (item.status === "SOURCE_REVIEW") action = `<button class="row-action" data-action="retry" data-id="${item.coverId}">Re-check</button><button class="row-action secondary" data-action="refund" data-id="${item.coverId}">Refund premium</button>`;
    }
    row.innerHTML = `<span class="activity-place"><i>◉</i><span><b>${escapeHtml(item.title)}</b><small>${escapeHtml(item.location)}${item.sample ? " · illustrative" : ""}</small></span></span><span>${escapeHtml(item.date)}</span><span>≥ ${item.threshold} mm</span><span><i class="status-pill ${badge}">${escapeHtml(item.status === "SAMPLE" ? "Sample proof" : item.status.replaceAll("_", " "))}</i></span><span>${escapeHtml(item.payout)}${action ? `<span class="row-actions">${action}</span>` : ""}</span>`;
    activityRows.append(row);
  }
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char);
}

function openSample() { demoDialog.showModal(); }

async function connectWallet() {
  if (!CONTRACT_ADDRESS) {
    showToast("Wallet actions unlock after the contract passes local checks and is deployed to Studionet.");
    return;
  }
  if (!window.ethereum) {
    showToast("MetaMask or another EIP-1193 wallet was not found.", "error");
    return;
  }
  try {
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
    if (!accounts?.[0]) throw new Error("No wallet account was returned.");
    connectedAddress = accounts[0];
    walletClient = createClient({ chain: studionet, account: connectedAddress as `0x${string}`, provider: window.ethereum as never });
    await walletClient.connect("studionet");
    walletLabel.textContent = `${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)}`;
    showToast("Wallet connected to Studionet.", "success");
    await refreshPool();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Wallet connection failed.", "error");
  }
}

async function sendContractWrite(functionName: string, args: unknown[] = [], value = 0n) {
  if (!walletClient || !connectedAddress || !CONTRACT_ADDRESS) throw new Error("Connect a wallet after a Studionet contract address is configured.");
    const hash = await walletClient.writeContract({
      address: CONTRACT_ADDRESS as `0x${string}`,
      functionName,
      args: args as CalldataEncodable[],
      value,
    });
    showToast("Transaction sent. Waiting for GenLayer finality…");
    const receipt = await walletClient.waitForTransactionReceipt({ hash, status: TransactionStatus.FINALIZED });
    if (receipt.txExecutionResultName !== ExecutionResult.FINISHED_WITH_RETURN) {
      throw new Error(`Contract call failed: ${receipt.statusName} / ${receipt.txExecutionResultName}`);
    }
  return hash;
}

async function refreshPool() {
  if (!readClient || !CONTRACT_ADDRESS) return;
  try {
    const [available, count] = await Promise.all([
      readClient.readContract({ address: CONTRACT_ADDRESS as `0x${string}`, functionName: "get_available_reserve", args: [] }),
      readClient.readContract({ address: CONTRACT_ADDRESS as `0x${string}`, functionName: "get_cover_count", args: [] }),
    ]);
    const gen = Number(available) / 1e18;
    $("pool-stat").innerHTML = `${gen.toFixed(3)} <small>GEN</small>`;
    $("pool-card-balance").innerHTML = `${gen.toFixed(3)} <small>GEN</small>`;
    $("covers-stat").textContent = String(count);
    $("pool-progress").style.width = `${Math.max(5, Math.min(gen * 20, 100))}%`;
    const numericCount = Number(count);
    const onchainRows = await Promise.all(Array.from({ length: Math.min(numericCount, 40) }, (_, index) =>
      readClient!.readContract({ address: CONTRACT_ADDRESS as `0x${string}`, functionName: "get_cover", args: [BigInt(index + 1)] })
    ));
    for (let i = activities.length - 1; i >= 0; i--) if (!activities[i].sample) activities.splice(i, 1);
    for (let i = 0; i < onchainRows.length; i++) {
      const entry = onchainRows[i] as Record<string, unknown>;
      if (entry.found === false) continue;
      const lat = Number(entry.latitude_e4) / 10000;
      const lon = Number(entry.longitude_e4) / 10000;
      activities.push({
        title: `Rain cover #${i + 1}`, location: `${lat.toFixed(4)}, ${lon.toFixed(4)}`,
        date: String(entry.event_date), threshold: Number(entry.threshold_mm),
        status: String(entry.status), payout: entry.status === "PAID" ? "Paid" : `${(Number(entry.payout_wei) / 1e18).toFixed(3)} GEN`, coverId: i + 1,
      });
    }
    renderActivity();
  } catch (error) {
    showToast(error instanceof Error ? `Couldn't refresh contract state: ${error.message}` : "Couldn't refresh contract state.", "error");
  }
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
    buildSourceUrls(latitude, longitude, date);
    if (!CONTRACT_ADDRESS) {
      showToast("The demo is ready, but no on-chain transaction was sent. Configure the tested contract after deployment.");
      return;
    }
    if (!walletClient) { showToast("Connect your wallet first. This click sent no transaction; after connecting, click again to continue.", "info"); return; }
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

function fundPool() {
  showToast("Funding is paused: the deployed contract has no reserve withdrawal function. Do not send GEN to this address.", "error");
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
    $("coords-label").textContent = `${latitude.toFixed(4)}° ${latitude >= 0 ? "N" : "S"}, ${Math.abs(longitude).toFixed(4)}° ${longitude >= 0 ? "E" : "W"}`;
    $("coord-inputs").classList.add("hidden");
  } catch (error) { showToast(error instanceof Error ? error.message : "Invalid coordinates.", "error"); }
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
    $("network-label").textContent = "Studionet · contract configured";
    document.body.dataset.mode = "live";
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
$("refresh-activity").addEventListener("click", refreshPool);
activityRows.addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  const button = target.closest<HTMLButtonElement>("button[data-action]");
  if (!button) return;
  const coverId = Number(button.dataset.id);
  const action = button.dataset.action;
  const functionName = action === "claim" ? "claim_payout" : action === "refund" ? "refund_source_conflict" : "resolve_claim";
  button.disabled = true;
  try {
    await sendContractWrite(functionName, [BigInt(coverId)]);
    await refreshPool();
    showToast(action === "claim" ? "Payout request finalized." : action === "refund" ? "Premium refund requested." : "Evidence checked by the contract.", "success");
  } catch (error) {
    button.disabled = false;
    showToast(error instanceof Error ? error.message : "Contract action failed.", "error");
  }
});
$("locate-me").addEventListener("click", useBrowserLocation);
$("edit-coords").addEventListener("click", (event) => { event.preventDefault(); $("coord-inputs").classList.toggle("hidden"); });
$("save-coords").addEventListener("click", () => setCoordinates("Custom coordinates"));
$("menu-toggle").addEventListener("click", () => document.querySelector(".main-nav")?.classList.toggle("nav-open"));
dateInput.addEventListener("change", () => { try { buildSourceUrls(Number(latitudeInput.value), Number(longitudeInput.value), dateInput.value); } catch { /* Native date validation is shown on submit. */ } });

setDateLimits();
updateThreshold();
setMode();
renderActivity();
if (CONTRACT_ADDRESS) {
  readClient = createClient({ chain: studionet });
  void refreshPool();
}
