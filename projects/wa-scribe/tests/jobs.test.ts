import { describe, expect, it } from "vitest";
import {
  driveDisconnected,
  inspectAfterRestart,
  markSaved,
  observeBatch,
  sourceDisconnected,
  startJob,
  stopJob,
  unmark,
  type Profile,
} from "../src/jobs";
import type { Binding } from "../src/model";

const binding: Binding = { accountId: "acct-1", chatId: "chat-1", destinationId: "dest-1", generation: "g1" };
const empty: Profile = { writerId: null, jobs: [] };

function started() {
  return startJob(empty, { id: "job-1", binding, mode: "download", upperAnchor: "m40" });
}

describe("job coordinator", () => {
  it("allows one writer and holds messages above the frozen anchor", () => {
    const first = started();
    expect(first.phase).toBe("ok");
    const second = startJob(first.profile, { id: "job-2", binding, mode: "download", upperAnchor: "m1" });
    expect(second.phase).toBe("rejected");
    const above = observeBatch(first.profile, "job-1", { accountId: "acct-1", chatId: "chat-1", ids: ["m41"], aboveAnchor: true });
    expect(above.job?.collected).toBe(0);
    expect(above.job?.stopReason).toBe("above-upper-anchor");
    const accepted = observeBatch(above.profile, "job-1", { accountId: "acct-1", chatId: "chat-1", ids: ["m39"], aboveAnchor: false });
    expect(accepted.job?.collected).toBe(1);
    const other = observeBatch(accepted.profile, "job-1", { accountId: "acct-1", chatId: "chat-9", ids: ["x"], aboveAnchor: false });
    expect(other.phase).toBe("rejected");
    expect(other.job?.result).toBe("needs permission");
    expect(other.profile.writerId).toBeNull();
  });

  it("keeps source and drive failures distinct and does not resume after restart", () => {
    const running = started();
    const collected = observeBatch(running.profile, "job-1", { accountId: "acct-1", chatId: "chat-1", ids: ["m1", "m2"], aboveAnchor: false });
    const source = sourceDisconnected(collected.profile, "job-1", 1);
    expect(source.job?.collected).toBe(2);
    expect(source.job?.saved).toBe(1);
    expect(source.job?.lastSuccess).toBe("partial-commit");
    expect(source.job?.gaps).toContain("source-disconnected");

    const again = started();
    const seen = observeBatch(again.profile, "job-1", { accountId: "acct-1", chatId: "chat-1", ids: ["m1"], aboveAnchor: false });
    const drive = driveDisconnected(seen.profile, "job-1");
    expect(drive.job?.phase).toBe("pending-save");
    expect(drive.job?.lastSuccess).toBeNull();
    expect(markSaved(drive.profile, "job-1").phase).toBe("rejected");

    const restarted = inspectAfterRestart(seen.profile);
    expect(restarted.job?.phase).toBe("interrupted");
    expect(restarted.job?.stopReason).toBe("restart");
    expect(restarted.profile.writerId).toBeNull();
  });

  it("stops and unmarks without deleting another chat's committed result", () => {
    const first = started();
    const saved = markSaved(observeBatch(first.profile, "job-1", { accountId: "acct-1", chatId: "chat-1", ids: ["m1"], aboveAnchor: false }).profile, "job-1");
    const otherBinding = { ...binding, chatId: "chat-2" };
    const second = startJob(saved.profile, { id: "job-2", binding: otherBinding, mode: "edit", upperAnchor: null });
    const stopped = stopJob(second.profile, "job-2");
    expect(stopped.job?.result).toBe("interrupted");
    expect(saved.job?.phase).toBe("committed");
    const unmarked = unmark(stopped.profile, "job-1");
    expect(unmarked.job?.unmarked).toBe(true);
    expect(unmarked.job?.saved).toBe(1);
    expect(observeBatch(unmarked.profile, "job-1", { accountId: "acct-1", chatId: "chat-1", ids: ["m2"], aboveAnchor: false }).phase).toBe("rejected");
  });
});