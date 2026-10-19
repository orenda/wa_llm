import { handleDrive } from "./chrome-drive";
import { isDriveRequest } from "./drive";
import { decide, isPanelSender } from "./protocol";

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  const context = { extensionId: sender.id ?? "", url: sender.url ?? "" };
  if (isDriveRequest(message)) {
    if (!isPanelSender(context, chrome.runtime.id)) {
      sendResponse({ phase: "rejected", account: null, warning: null, httpStatus: null });
      return undefined;
    }
    void handleDrive(message).then(sendResponse);
    return true;
  }
  sendResponse(decide(message, context, chrome.runtime.id));
  return undefined;
});
