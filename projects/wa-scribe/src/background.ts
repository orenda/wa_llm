import { handleDrive } from "./chrome-drive";
import { isDriveRequest, isDriveStatus } from "./drive";
import { decide, isPanelSender } from "./protocol";
import { handleApp, isAppRequest } from "./export-service";

chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isDriveStatus(message)) return undefined;
  const context = { extensionId: sender.id ?? "", url: sender.url ?? "" };
  if (isAppRequest(message)) {
    if (!isPanelSender(context, chrome.runtime.id)) {
      sendResponse({ ok: false, error: "Only the extension panel may operate exports." });
      return undefined;
    }
    void handleApp(message).then(sendResponse).catch(() => sendResponse({ ok: false, error: "The worker stopped. Refresh; no collection resumes automatically." }));
    return true;
  }
  if (isDriveRequest(message)) {
    if (!isPanelSender(context, chrome.runtime.id)) {
      sendResponse({ phase: "rejected", account: null, warning: null, httpStatus: null, pendingId: null });
      return undefined;
    }
    void handleDrive(message).then(sendResponse);
    return true;
  }
  sendResponse(decide(message, context, chrome.runtime.id));
  return undefined;
});
