import { handleDrive } from "./chrome-drive";
import { isDriveRequest, isDriveStatus } from "./drive";
import { decide, isPanelSender } from "./protocol";

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (isDriveStatus(message)) return undefined;
  const context = { extensionId: sender.id ?? "", url: sender.url ?? "" };
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
