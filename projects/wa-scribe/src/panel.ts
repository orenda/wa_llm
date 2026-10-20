import { isDriveResult, panelCopy, type DriveResult } from "./drive";
import { createManifest } from "./manifest";
import { bakedOAuth, DRIVE_FILE_SCOPE } from "./public-config";

const APP_PROTOCOL = "wa-scribe.app";
const INSTALL_URL = "https://github.com/orenda/wa_llm/blob/codex/wa-scribe-complete/projects/wa-scribe/docs/INSTALL.md";
const MAX_LIMIT = 500;
const GOOGLE_CLIENT_ID = /^[0-9]{6,}-[A-Za-z0-9_-]+\.apps\.googleusercontent\.com$/;

type ChatState = {
  key: string;
  accountId: string;
  chatId: string;
  name: string;
  selected: boolean;
  result: string;
  lastSuccess: string | null;
  url: string | null;
  exportUrl?: string | null;
  archives?: { url: string; accountId: string; generation: string; deleted?: boolean }[];
};

type AppState = {
  revision?: number;
  drive: DriveResult | null;
  chats: ChatState[];
  job: { phase: string; chatKey: string | null; count: number; reason: string | null } | null;
  setup: boolean;
};

type AppReply = { ok: boolean; error?: string; state?: AppState };
type Action = "state" | "connect" | "probe" | "add-current" | "select" | "sync" | "stop" | "recover" | "fresh" | "delete";
type Request = { protocol: typeof APP_PROTOCOL; type: Action; [key: string]: unknown };

const byId = <T extends HTMLElement>(id: string, kind: { new(): T }): T => {
  const node = document.getElementById(id);
  if (!(node instanceof kind)) throw new Error(`Missing panel element: ${id}`);
  return node;
};

const statusNode = byId("status", HTMLParagraphElement);
const accountNode = byId("account", HTMLParagraphElement);
const noticeNode = byId("notice", HTMLParagraphElement);
const driveActions = byId("drive-actions", HTMLDivElement);
const driveConnect = byId("drive-connect", HTMLDivElement);
const driveTools = byId("drive-tools", HTMLDetailsElement);
const chatList = byId("chat-list", HTMLDivElement);
const chatEmpty = byId("chat-empty", HTMLParagraphElement);
const jobNode = byId("job-status", HTMLParagraphElement);
const errorNode = byId("action-error", HTMLParagraphElement);
const limitInput = byId("history-limit", HTMLInputElement);
const modeSelect = byId("mode", HTMLSelectElement);
const scopeSelect = byId("scope", HTMLSelectElement);
const syncButton = byId("sync", HTMLButtonElement);
const stopButton = byId("stop", HTMLButtonElement);
const refreshButton = byId("refresh", HTMLButtonElement);
const addButton = byId("add-current", HTMLButtonElement);
const connectButton = byId("connect", HTMLButtonElement);
const probeButton = byId("probe-run", HTMLButtonElement);
const warningNode = byId("mode-warning", HTMLParagraphElement);
const configureButton = byId("configure-drive", HTMLButtonElement);

let current: AppState | null = null;
let pollTimer: number | undefined;
let stateRequestInFlight = false;
let actionBusy = false;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isChat(value: unknown): value is ChatState {
  if (!isRecord(value)) return false;
  return typeof value.key === "string" && typeof value.accountId === "string" && typeof value.chatId === "string" &&
    typeof value.name === "string" && typeof value.selected === "boolean" && typeof value.result === "string" &&
    (value.lastSuccess === null || typeof value.lastSuccess === "string") &&
    (value.url === null || (typeof value.url === "string" && safeDriveUrl(value.url) !== null)) &&
    (value.exportUrl === undefined || value.exportUrl === null || (typeof value.exportUrl === "string" && safeDriveUrl(value.exportUrl) !== null)) &&
    (value.archives === undefined || (Array.isArray(value.archives) && value.archives.every((archive) => isRecord(archive) &&
      typeof archive.url === "string" && safeDriveUrl(archive.url) !== null && typeof archive.accountId === "string" && typeof archive.generation === "string" &&
      (archive.deleted === undefined || typeof archive.deleted === "boolean"))));
}

function safeDriveUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === "https:" && (url.hostname === "docs.google.com" || url.hostname.endsWith(".docs.google.com") || url.hostname === "drive.google.com" || url.hostname.endsWith(".drive.google.com")) ? url.href : null;
  } catch {
    return null;
  }
}

function isAppState(value: unknown): value is AppState {
  if (!isRecord(value) || !Array.isArray(value.chats)) return false;
  const job = value.job;
  const validJob = job === null || (isRecord(job) && typeof job.phase === "string" &&
    (job.chatKey === null || typeof job.chatKey === "string") && typeof job.count === "number" && Number.isInteger(job.count) &&
    (job.reason === null || typeof job.reason === "string"));
  return (value.revision === undefined || (typeof value.revision === "number" && Number.isSafeInteger(value.revision) && value.revision >= 0)) &&
    (value.drive === null || isDriveResult(value.drive)) && value.chats.every(isChat) && validJob && typeof value.setup === "boolean";
}

function isAppReply(value: unknown): value is AppReply {
  return isRecord(value) && typeof value.ok === "boolean" && (value.error === undefined || typeof value.error === "string") &&
    (value.state === undefined || isAppState(value.state));
}

function send(type: Action, fields: Record<string, unknown> = {}, done: (reply: AppReply | null) => void = () => undefined): void {
  const request: Request = { protocol: APP_PROTOCOL, type, ...fields };
  chrome.runtime.sendMessage(request, (response: unknown) => {
    if (chrome.runtime.lastError || !isAppReply(response)) {
      done(null);
      return;
    }
    done(response);
  });
}

function setError(message: string): void {
  errorNode.textContent = message;
}

function action(type: Action, fields: Record<string, unknown> = {}): void {
  if (actionBusy && type !== "stop") return;
  const ownsBusy = !actionBusy;
  if (ownsBusy) actionBusy = true;
  setError("");
  updateControls();
  send(type, fields, (reply) => {
    if (ownsBusy) actionBusy = false;
    if (!reply) setError("The extension could not complete that request. Refresh and try again.");
    else if (!reply.ok) setError(reply.error ?? "The request could not be completed.");
    if (reply?.state) applyState(reply.state);
    updateControls();
  });
}

function updateControls(): void {
  const drive = current?.drive ?? null;
  const accountId = drive?.account?.permissionId;
  const connected = current?.setup === true && !!accountId && drive !== null && ["connected", "verified", "account-changed", "root-missing"].includes(drive.phase);
  const connectContainer = connected ? driveActions : driveConnect;
  if (connectButton.parentElement !== connectContainer) connectContainer.prepend(connectButton);
  connectButton.textContent = connected ? "Reconnect Google Drive" : "Connect Google Drive";
  const running = current?.job !== null && current?.job !== undefined;
  connectButton.disabled = actionBusy || running || current === null || !current.setup || drive?.phase === "missing-setup";
  probeButton.disabled = actionBusy || running || !accountId || drive?.phase === "missing-setup";
  addButton.disabled = actionBusy || running || current === null;
  configureButton.disabled = actionBusy || running;
  refreshButton.disabled = false;
  stopButton.disabled = !running;
  const selected = current?.chats.some((chat) => chat.selected) ?? false;
  syncButton.disabled = actionBusy || !accountId || !selected || running;
  driveActions.hidden = !(current?.setup ?? false);
  configureButton.hidden = current?.setup === true && drive?.phase !== "missing-setup";
}

function addText(parent: Element, tag: string, text: string, className?: string): HTMLElement {
  const node = document.createElement(tag);
  node.textContent = text;
  if (className) node.className = className;
  parent.append(node);
  return node;
}

function addLink(parent: Element, label: string, href: string): void {
  const link = document.createElement("a");
  link.textContent = label;
  link.href = href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  parent.append(link);
}

function conciseStatus(result: string): string {
  if (!result) return "Not synced";
  const knownReasons: Record<string, string> = {
    "visible-window": "Rendered messages only",
    "history-boundary-unverified": "Older-history boundary unverified",
    "scope-boundary-unverified": "Requested scope boundary unverified",
    "message-budget": "Message limit reached",
    "time-budget": "Time limit reached",
    "byte-budget": "Export size limit reached",
    "unverified-history-overlap": "History could not be safely joined",
    "history-scroll-unavailable": "Older history could not be reached",
    "unloaded-message": "Some messages were not loaded",
    "unsupported-message-envelope": "Some messages could not be read",
    "unverified-between": "A gap remains in the saved history",
    "stopped": "Stopped",
  };
  const partial = /^(.*?\bPartial):\s*(.+)$/u.exec(result);
  if (partial?.[1] && partial[2]) return `${partial[1]}: ${knownReasons[partial[2]] ?? "Some history could not be verified"}`;
  return result;
}

function renderChats(): void {
  chatList.replaceChildren();
  const chats = current?.chats ?? [];
  chatEmpty.hidden = chats.length > 0;
  for (const chat of chats) {
    const row = document.createElement("article");
    row.className = "chat-row";
    const title = document.createElement("div");
    title.className = "chat-title";
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = chat.selected;
    checkbox.disabled = actionBusy || (current?.job != null && !chat.selected);
    checkbox.setAttribute("aria-label", `Select ${chat.name}`);
    checkbox.addEventListener("change", () => action("select", { key: chat.key, selected: checkbox.checked }));
    title.append(checkbox);
    addText(title, "strong", chat.name || "Unnamed chat");
    row.append(title);
    addText(row, "p", conciseStatus(chat.result), "chat-status");
    const controls = document.createElement("div");
    controls.className = "chat-controls";
    const candidateExportUrl = chat.exportUrl ?? chat.url;
    if (candidateExportUrl) {
      const safe = safeDriveUrl(candidateExportUrl);
      if (safe) addLink(controls, "Open export", safe);
    }
    const more = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "More actions";
    more.append(summary);
    addText(more, "p", `Account ID: ${chat.accountId}`, "identity");
    addText(more, "p", `Chat ID: ${chat.chatId}`, "identity");
    if (chat.lastSuccess) addText(more, "p", `Last success: ${chat.lastSuccess}`, "identity");
    addText(more, "p", `Result detail: ${chat.result || "Not synced"}`, "identity");
    chat.archives?.forEach((archive, index) => {
      const safe = safeDriveUrl(archive.url);
      if (safe) addLink(more, `${archive.deleted ? "Open retained folder" : "Open archived export"} ${index + 1}`, safe);
    });
    for (const [label, type] of [["Recover", "recover"], ["Start fresh", "fresh"], ["Delete export", "delete"]] as const) {
      const button = document.createElement("button");
      button.type = "button";
      button.textContent = label;
      button.disabled = actionBusy || (current?.job != null);
      button.addEventListener("click", () => {
        if (type === "fresh" && !window.confirm("Start a fresh export tree for this chat? The old tree will be preserved.")) return;
        if (type === "delete" && !window.confirm("Trash only this export's recorded transcript.md and sync.json files? Export folders, untracked media, and earlier archived exports will be kept.")) return;
        const expectedAccountId = current?.drive?.account?.permissionId;
        if (!expectedAccountId) {
          setError("Connect Google Drive and confirm the account before changing this export.");
          return;
        }
        action(type, type === "delete"
          ? { key: chat.key, confirmation: chat.key, expectedAccountId }
          : { key: chat.key, expectedAccountId });
      });
      more.append(button);
    }
    row.append(controls);
    row.append(more);
    chatList.append(row);
  }
}

function applyState(state: AppState): void {
  if (current?.revision !== undefined && state.revision !== undefined && state.revision < current.revision) return;
  if (!state.setup || state.drive?.phase === "missing-setup") driveTools.open = true;
  current = state;
  const drive = state.drive;
  if (drive) {
    const copy = panelCopy(drive);
    statusNode.textContent = copy.status;
    accountNode.textContent = drive.account?.emailAddress ?? "";
    noticeNode.textContent = copy.notice;
  } else {
    statusNode.textContent = "Google Drive has not been connected.";
    accountNode.textContent = "";
    noticeNode.textContent = "";
  }
  if (!state.setup) {
    statusNode.textContent = "Google Drive setup is missing. Follow the install guide to configure the OAuth client ID and extension public key.";
    noticeNode.replaceChildren();
    addLink(noticeNode, "Open install guide", INSTALL_URL);
  }
  if (state.job) jobNode.textContent = `${state.job.phase}${state.job.count ? ` · ${state.job.count} messages` : ""}${state.job.reason ? ` · ${state.job.reason}` : ""}`;
  else jobNode.textContent = "No sync in progress.";
  renderChats();
  updateControls();
  if (state.job) schedulePoll();
  else {
    if (pollTimer !== undefined) window.clearTimeout(pollTimer);
    pollTimer = undefined;
  }
}

function schedulePoll(): void {
  if (pollTimer !== undefined || stateRequestInFlight) return;
  pollTimer = window.setTimeout(() => {
    pollTimer = undefined;
    refreshState("Could not refresh sync status. Use Refresh to retry.");
  }, 2000);
}

function refreshState(failureMessage: string): void {
  if (stateRequestInFlight) return;
  stateRequestInFlight = true;
  send("state", {}, (reply) => {
    stateRequestInFlight = false;
    if (reply?.state) applyState(reply.state);
    else if (!reply) setError(failureMessage);
    if (current?.job) schedulePoll();
  });
}

warningNode.textContent = "Text and captions only; original attachments are not saved yet.";
configureButton.addEventListener("click", () => {
  const entered = window.prompt("Enter your public Google OAuth client ID. Do not enter a client secret.");
  if (entered === null) return;
  const clientId = entered.trim();
  if (!GOOGLE_CLIENT_ID.test(clientId)) {
    setError("That does not look like a Google OAuth client ID. Enter the public ID ending in .apps.googleusercontent.com.");
    return;
  }
  const manifest = createManifest("production", { clientId, extensionKey: bakedOAuth().extensionKey });
  manifest.oauth2 = { client_id: clientId, scopes: [DRIVE_FILE_SCOPE] };
  const blob = new Blob([`${JSON.stringify(manifest, null, 2)}\n`], { type: "application/json" });
  const downloadUrl = URL.createObjectURL(blob);
  noticeNode.replaceChildren();
  addText(noticeNode, "span", "Replace manifest.json in your unpacked extension folder with the downloaded file, then reload the extension.");
  noticeNode.append(document.createTextNode(" "));
  const link = document.createElement("a");
  link.textContent = "Download manifest.json";
  link.href = downloadUrl;
  link.download = "manifest.json";
  noticeNode.append(link);
  link.addEventListener("click", () => window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1000), { once: true });
  setError("");
});
connectButton.addEventListener("click", () => action("connect"));
probeButton.addEventListener("click", () => {
  const drive = current?.drive;
  const accountId = drive?.account?.permissionId;
  if (!accountId) return;
  action("probe", { expectedAccountId: accountId, ...(drive.pendingId ? { ackPendingId: drive.pendingId } : {}) });
});
addButton.addEventListener("click", () => action("add-current"));
refreshButton.addEventListener("click", () => {
  if (pollTimer !== undefined) window.clearTimeout(pollTimer);
  pollTimer = undefined;
  refreshState("The extension could not refresh panel state.");
});
stopButton.addEventListener("click", () => action("stop"));
modeSelect.addEventListener("change", () => {
  warningNode.textContent = modeSelect.value === "edit"
    ? "Edit mode can remove saved content. Text and captions only; original attachments are not saved yet."
    : "Text and captions only; original attachments are not saved yet.";
});
syncButton.addEventListener("click", () => {
  const drive = current?.drive;
  const expectedAccountId = drive?.account?.permissionId;
  if (!expectedAccountId) return;
  const limit = Number.parseInt(limitInput.value, 10);
  action("sync", {
    mode: modeSelect.value === "edit" ? "edit" : "download",
    scope: scopeSelect.value === "loaded" ? "loaded" : "visible",
    limit: Number.isFinite(limit) ? Math.max(1, Math.min(MAX_LIMIT, limit)) : 50,
    expectedAccountId,
  });
});

refreshState("The extension could not load panel state. Use Refresh to retry.");
