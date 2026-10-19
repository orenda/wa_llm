import { isDriveResult, isDriveStatus, type DriveResult } from "./drive";
import { initialPanelView, panelRequest, planPanel, type PanelView } from "./panel-state";
import { contentHello, invalidRequest, panelPing } from "./protocol";
import { reportExchange } from "./report";

reportExchange("#panel-pong", panelPing());
reportExchange("#panel-wrong-context", contentHello("panel-as-content"));
reportExchange("#panel-invalid", invalidRequest());

const statusNode = document.querySelector("#status");
const accountNode = document.querySelector("#account");
const noticeNode = document.querySelector("#notice");
const connectButton = document.querySelector("#connect");
const probeButton = document.querySelector("#probe-run");

let view: PanelView = initialPanelView;
let epoch = 0;

function render(): void {
  if (statusNode) statusNode.textContent = view.status;
  if (accountNode) accountNode.textContent = view.account;
  if (noticeNode) noticeNode.textContent = view.notice;
  if (connectButton instanceof HTMLButtonElement) connectButton.disabled = view.connectDisabled;
  if (probeButton instanceof HTMLButtonElement) probeButton.disabled = view.probeDisabled;
}

function apply(result: DriveResult): void {
  epoch += 1;
  const scheduled = epoch;
  view = planPanel(view, result);
  render();
  if (!view.refresh) return;
  setTimeout(() => {
    if (epoch !== scheduled) return;
    post("restore");
  }, 300);
}

function post(type: "connect" | "restore" | "probe"): void {
  const sent = epoch;
  chrome.runtime.sendMessage(panelRequest(type, view.seenPendingId), (reply: unknown) => {
    if (epoch !== sent) return;
    if (chrome.runtime.lastError || !isDriveResult(reply)) {
      if (statusNode) statusNode.textContent = "The extension worker did not answer.";
      if (connectButton instanceof HTMLButtonElement) connectButton.disabled = false;
      return;
    }
    apply(reply);
  });
}

function arm(type: "connect" | "probe"): void {
  if (connectButton instanceof HTMLButtonElement) connectButton.disabled = true;
  if (probeButton instanceof HTMLButtonElement) probeButton.disabled = true;
  post(type);
}

chrome.runtime.onMessage.addListener((message: unknown) => {
  if (!isDriveStatus(message)) return undefined;
  apply(message.result);
  return undefined;
});

if (connectButton instanceof HTMLButtonElement) connectButton.addEventListener("click", () => arm("connect"));
if (probeButton instanceof HTMLButtonElement) probeButton.addEventListener("click", () => arm("probe"));
post("restore");
