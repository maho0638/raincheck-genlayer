import { createClient } from "genlayer-js";
import { studionet } from "genlayer-js/chains";
import { ExecutionResult, TransactionStatus, type CalldataEncodable } from "genlayer-js/types";
import { buildSourceUrls, decideRainfall, formatRain } from "./weather";
import { fetchRainEvidence } from "./evidence";
import "./style.css";

declare global { interface Window { ethereum?: { request(args: { method: string; params?: unknown[] }): Promise<unknown> } } }

const DEPLOYED_CONTRACT_ADDRESS = "0xb94D1922362B0Ac6936e908DF677aC89D05dFC51";
const LEGACY_CONTRACT_ADDRESS = DEPLOYED_CONTRACT_ADDRESS;
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
let availableReserve: bigint | null = null;
let verifiedV2 = false;
let contractOwner = "";
const MIN_AVAILABLE_FOR_COVER = 8_000_000_000_000_000n;

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
    if (verifiedV2 && !item.sample && item.coverId) {
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
    const accounts = await window.ethereum.request({ method: "eth_requestAccounts" }) as string[];
    if (!accounts?.[0]) throw new Error("No wallet account was returned.");
    connectedAddress = accounts[0];
    walletClient = createClient({ chain: studionet, account: connectedAddress as `0x${string}`, provider: window.ethereum as never });
    await walletClient.connect("studionet");
    walletLabel.textContent = `${connectedAddress.slice(0, 6)}…${connectedAddress.slice(-4)}`;
    updateAdminControls();
    showToast("Wallet connected to Studionet.", "success");
    await refreshPool();
  } catch (error) {
    showToast(error instanceof Error ? error.message : "Wallet connection failed.", "error");
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
    const receipt = await walletClient.waitForTransactionReceipt({ hash, status: TransactionStatus.FINALIZED });
    if (receipt.txExecutionResultName !== ExecutionResult.FINISHED_WITH_RETURN) {
      throw new Error(`Contract call failed: ${receipt.statusName} / ${receipt.txExecutionResultName}`);
    }
  return hash;
}

async function refreshPool() {
  if (!readClient || !CONTRACT_ADDRESS) {
    availableReserve = null;
    updateCoverAvailability();
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
    availableReserve = null;
    updateCoverAvailability();
    $("reserve-status").textContent = "Contract read unavailable";
    updateAdminControls();
    showToast(error instanceof Error ? `Couldn't refresh contract state: ${error.message}` : "Couldn't refresh contract state.", "error");
  }
}

function updateCoverAvailability() {
  const button = $("create-cover") as HTMLButtonElement;
  const note = $("cover-availability");
  const canCreate = verifiedV2 && availableReserve !== null && availableReserve >= MIN_AVAILABLE_FOR_COVER;
  button.disabled = !canCreate;
  button.querySelector("span")!.textContent = canCreate ? "Activate cover" : "Cover unavailable";
  note.textContent = canCreate
    ? "Verified RainCheck V2 reserve. Connect the pool owner wallet to continue."
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
    status.textContent = "Requesting archived readings from both public sources…";
    try {
      const preview = await fetchRainEvidence(
        Number(($("lab-latitude") as HTMLInputElement).value),
        Number(($("lab-longitude") as HTMLInputElement).value),
        dateField.value,
        Number(($("lab-threshold") as HTMLInputElement).value),
      );
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
  $("reserve-mode").textContent = verifiedV2 ? ownerConnected ? "V2 · OWNER WALLET" : "V2 · OWNER ONLY" : "LEGACY · READ ONLY";
  $("network-label").textContent = verifiedV2 ? "Studionet · RainCheck V2" : CONTRACT_ADDRESS ? "Studionet · legacy read-only" : "Studionet preview";
  document.body.dataset.mode = verifiedV2 ? "live" : "preview";
  $("pool-info-title").textContent = verifiedV2 ? "Owner controlled. Payouts stay locked." : "Legacy reserve stays read only.";
  $("pool-info-copy").textContent = verifiedV2
    ? "Only the deployer can add test liquidity or withdraw free reserve. Funds backing active covers cannot be withdrawn. Test GEN has no real-world value."
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
    if (!walletClient) { await connectWallet(); if (!walletClient) { button.disabled = false; return; } }
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
initializeEvidenceLab();
updateThreshold();
setMode();
renderActivity();
if (CONTRACT_ADDRESS) {
  readClient = createClient({ chain: studionet });
  void refreshPool();
}
