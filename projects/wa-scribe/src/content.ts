import { contentHello, panelPing } from "./protocol";
import { reportExchange } from "./report";
import { diagnose, readSource } from "./source";

function replyDelay(): number {
  const delay = Number(new URLSearchParams(location.search).get("replyDelay"));
  if (!Number.isFinite(delay) || delay <= 0) return 0;
  return Math.min(delay, 5_000);
}

function report(): void {
  reportExchange("#content-ack", contentHello());
  reportExchange("#content-wrong-context", panelPing("content-as-panel"));
}

function reportSource(): void {
  const diagnostic = document.querySelector("#source-diagnostic");
  if (diagnostic) diagnostic.textContent = JSON.stringify(diagnose(document.documentElement.outerHTML));
  if (new URLSearchParams(location.search).get("probe") !== "1") return;
  const probe = document.querySelector("#source-probe");
  if (probe) probe.textContent = JSON.stringify(readSource(document.documentElement.outerHTML));
}

const delay = replyDelay();
if (delay === 0) {
  report();
  reportSource();
} else {
  setTimeout(() => {
    report();
    reportSource();
  }, delay);
}
