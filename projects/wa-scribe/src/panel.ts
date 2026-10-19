import { DRIVE_PROTOCOL, panelCopy, type DriveResult } from "./drive";
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

function show(result: DriveResult): void {
  const copy = panelCopy(result);
  if (statusNode) statusNode.textContent = copy.status;
  if (accountNode) accountNode.textContent = copy.account;
  if (noticeNode) noticeNode.textContent = copy.notice;
  const blocked = result.phase === "missing-setup" || result.phase === "busy";
  if (connectButton instanceof HTMLButtonElement) connectButton.disabled = blocked;
  const canProbe = result.account !== null && result.phase !== "busy" && result.phase !== "auth-expired" && result.phase !== "missing-setup";
  if (probeButton instanceof HTMLButtonElement) probeButton.disabled = !canProbe;
}

function send(type: "restore" | "connect" | "probe"): void {
  chrome.runtime.sendMessage({ protocol: DRIVE_PROTOCOL, type }, (reply: unknown) => {
    if (chrome.runtime.lastError || !isDriveResult(reply)) {
      if (statusNode) statusNode.textContent = "The extension worker did not answer.";
      if (connectButton instanceof HTMLButtonElement) connectButton.disabled = false;
      return;
    }
    show(reply);
  });
}

function arm(type: "connect" | "probe"): void {
  if (connectButton instanceof HTMLButtonElement) connectButton.disabled = true;
  if (probeButton instanceof HTMLButtonElement) probeButton.disabled = true;
  send(type);
}

function isDriveResult(value: unknown): value is DriveResult {
  return typeof value === "object" && value !== null && "phase" in value && "account" in value && "warning" in value && "httpStatus" in value;
}

if (connectButton instanceof HTMLButtonElement) connectButton.addEventListener("click", () => arm("connect"));
if (probeButton instanceof HTMLButtonElement) probeButton.addEventListener("click", () => arm("probe"));
send("restore");
