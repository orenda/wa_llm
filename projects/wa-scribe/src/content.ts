import { contentHello, panelPing } from "./protocol";
import { reportExchange } from "./report";
import { runTextDownload } from "./alpha";
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
  const params = new URLSearchParams(location.search);
  if (params.get("probe") === "1") {
    const probe = document.querySelector("#source-probe");
    if (probe) probe.textContent = JSON.stringify(readSource(document.documentElement.outerHTML));
  }
  if (params.get("download") !== "1") return;
  const alpha = document.querySelector("#alpha-result");
  if (!alpha) return;
  alpha.textContent = JSON.stringify(
    runTextDownload({
      html: document.documentElement.outerHTML,
      expected: { accountId: "acct-1", chatId: "chat-1" },
      prefix: "",
      binding: { accountId: "acct-1", chatId: "chat-1", destinationId: "root-1", generation: "g1" },
      chatKey: "c7a18d2f",
      displayName: "Fixture",
      desk: { markdown: null, metadata: null, mediaIds: [] },
      journal: null,
      chat: null,
    }),
  );
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
