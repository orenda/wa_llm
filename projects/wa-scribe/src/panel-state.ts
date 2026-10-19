import { DRIVE_PROTOCOL, panelCopy, type DriveRequest, type DriveResult } from "./drive";

export const MAX_BUSY_POLLS = 8;

export type PanelView = {
  status: string;
  account: string;
  notice: string;
  connectDisabled: boolean;
  probeDisabled: boolean;
  seenPendingId: string | null;
  busyPolls: number;
  refresh: boolean;
};

export const initialPanelView: PanelView = {
  status: "",
  account: "",
  notice: "",
  connectDisabled: true,
  probeDisabled: true,
  seenPendingId: null,
  busyPolls: 0,
  refresh: false,
};

/** Restore while Busy. A refresh never starts consent or a Drive test. */
export function panelRequest(type: "connect" | "restore" | "probe", seenPendingId: string | null): DriveRequest {
  if (type === "probe" && seenPendingId !== null) return { protocol: DRIVE_PROTOCOL, type, ackPendingId: seenPendingId };
  return { protocol: DRIVE_PROTOCOL, type };
}

export function planPanel(previous: PanelView, result: DriveResult): PanelView {
  const copy = panelCopy(result);
  if (result.phase === "busy") {
    const busyPolls = previous.busyPolls + 1;
    return {
      status: copy.status,
      account: copy.account,
      notice: copy.notice,
      connectDisabled: true,
      probeDisabled: true,
      seenPendingId: previous.seenPendingId,
      busyPolls,
      refresh: busyPolls <= MAX_BUSY_POLLS,
    };
  }
  const probeDisabled = result.account === null || result.phase === "auth-expired" || result.phase === "missing-setup";
  return {
    status: copy.status,
    account: copy.account,
    notice: copy.notice,
    connectDisabled: result.phase === "missing-setup",
    probeDisabled,
    seenPendingId: result.pendingId,
    busyPolls: 0,
    refresh: false,
  };
}
