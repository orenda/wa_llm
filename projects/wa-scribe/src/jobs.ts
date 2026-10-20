import type { Binding } from "./model";

export const PASS_MESSAGE_BUDGET = 500;

export type JobPhase = "collecting" | "pending-save" | "committed" | "interrupted" | "recovery-required";

export type PassResult = "complete for requested scope" | "partial" | "interrupted" | "needs permission" | "conflict" | "recovery required" | "failed";

export type Job = {
  id: string;
  binding: Binding;
  mode: "download" | "edit";
  upperAnchor: string | null;
  phase: JobPhase;
  collected: number;
  saved: number;
  lastSuccess: string | null;
  result: PassResult | null;
  stopReason: string | null;
  unmarked: boolean;
  gaps: string[];
};

export type Profile = { writerId: string | null; jobs: Job[] };

export type JobResult = { profile: Profile; job: Job | null; phase: "ok" | "rejected" };

function replace(profile: Profile, job: Job): Profile {
  return { ...profile, jobs: profile.jobs.map((entry) => (entry.id === job.id ? job : entry)) };
}

function ownsWriter(profile: Profile, job: Job | undefined): job is Job {
  return job !== undefined && profile.writerId === job.id && !job.unmarked && job.phase === "collecting";
}

function release(profile: Profile, job: Job): Profile {
  return { ...replace(profile, job), writerId: profile.writerId === job.id ? null : profile.writerId };
}

export function startJob(profile: Profile, job: Omit<Job, "phase" | "collected" | "saved" | "lastSuccess" | "result" | "stopReason" | "unmarked" | "gaps">): JobResult {
  const unsettled = profile.jobs.some((entry) => (entry.phase === "pending-save" || entry.phase === "recovery-required") && entry.binding.accountId === job.binding.accountId && entry.binding.chatId === job.binding.chatId && entry.binding.destinationId === job.binding.destinationId);
  if (profile.writerId !== null || unsettled || profile.jobs.some((entry) => entry.id === job.id)) return { profile, job: null, phase: "rejected" };
  const next: Job = {
    ...job,
    phase: "collecting",
    collected: 0,
    saved: 0,
    lastSuccess: null,
    result: null,
    stopReason: null,
    unmarked: false,
    gaps: [],
  };
  return { profile: { writerId: job.id, jobs: [...profile.jobs, next] }, job: next, phase: "ok" };
}

export function observeBatch(
  profile: Profile,
  jobId: string,
  batch: { accountId: string; chatId: string; ids: string[]; aboveAnchor: boolean },
): JobResult {
  const job = profile.jobs.find((entry) => entry.id === jobId);
  if (!ownsWriter(profile, job)) return { profile, job: job ?? null, phase: "rejected" };
  if (batch.accountId !== job.binding.accountId || batch.chatId !== job.binding.chatId) {
    const paused = { ...job, phase: "interrupted" as const, result: "needs permission" as const, stopReason: "chat-mismatch" };
    return { profile: release(profile, paused), job: paused, phase: "rejected" };
  }
  if (batch.aboveAnchor) {
    const held = { ...job, stopReason: "above-upper-anchor" };
    return { profile: replace(profile, held), job: held, phase: "ok" };
  }
  const room = Math.max(PASS_MESSAGE_BUDGET - job.collected, 0);
  const accepted = batch.ids.slice(0, room);
  const next = {
    ...job,
    collected: job.collected + accepted.length,
    stopReason: accepted.length < batch.ids.length ? "message-budget" : job.stopReason,
    result: accepted.length < batch.ids.length ? ("partial" as const) : job.result,
  };
  return { profile: replace(profile, next), job: next, phase: "ok" };
}

export function sourceDisconnected(profile: Profile, jobId: string, coherentSaved: number | null): JobResult {
  const job = profile.jobs.find((entry) => entry.id === jobId);
  if (!ownsWriter(profile, job) || (coherentSaved !== null && (!Number.isSafeInteger(coherentSaved) || coherentSaved < 0 || coherentSaved > job.collected))) return { profile, job: job ?? null, phase: "rejected" };
  const partial = coherentSaved !== null;
  const next: Job = {
    ...job,
    phase: partial ? "committed" : "interrupted",
    saved: coherentSaved ?? job.saved,
    lastSuccess: partial ? "partial-commit" : job.lastSuccess,
    result: partial ? "partial" : "interrupted",
    stopReason: "source-disconnected",
    gaps: [...job.gaps, "source-disconnected"],
  };
  return { profile: release(profile, next), job: next, phase: "ok" };
}

export function driveDisconnected(profile: Profile, jobId: string): JobResult {
  const job = profile.jobs.find((entry) => entry.id === jobId);
  if (!ownsWriter(profile, job)) return { profile, job: job ?? null, phase: "rejected" };
  const next: Job = { ...job, phase: "pending-save", result: "interrupted", stopReason: "drive-disconnected" };
  return { profile: replace(profile, next), job: next, phase: "ok" };
}

export function markSaved(profile: Profile, jobId: string): JobResult {
  const job = profile.jobs.find((entry) => entry.id === jobId);
  if (!ownsWriter(profile, job)) return { profile, job: job ?? null, phase: "rejected" };
  const next: Job = { ...job, phase: "committed", saved: job.collected, lastSuccess: "committed", result: job.result ?? "complete for requested scope" };
  return { profile: release(profile, next), job: next, phase: "ok" };
}

export function stopJob(profile: Profile, jobId: string): JobResult {
  const job = profile.jobs.find((entry) => entry.id === jobId);
  if (!job || profile.writerId !== job.id || (job.phase !== "collecting" && job.phase !== "pending-save")) return { profile, job: job ?? null, phase: "rejected" };
  const next: Job = { ...job, phase: job.phase === "pending-save" ? "pending-save" : "interrupted", result: "interrupted", stopReason: "stop" };
  return { profile: next.phase === "pending-save" ? replace(profile, next) : release(profile, next), job: next, phase: "ok" };
}

export function unmark(profile: Profile, jobId: string): JobResult {
  const job = profile.jobs.find((entry) => entry.id === jobId);
  if (!job) return { profile, job: null, phase: "rejected" };
  const terminal = job.phase === "committed" || job.phase === "recovery-required";
  const next: Job = { ...job, unmarked: true, phase: terminal || job.phase === "pending-save" ? job.phase : "interrupted", result: terminal ? job.result : "interrupted", stopReason: "unmarked" };
  return { profile: next.phase === "pending-save" ? replace(profile, next) : release(profile, next), job: next, phase: "ok" };
}

/** Startup may inspect a job. Collection does not continue until the user starts again. */
export function inspectAfterRestart(profile: Profile): JobResult {
  const job = profile.jobs.find((entry) => entry.id === profile.writerId) ?? null;
  const cleared = { ...profile, writerId: null };
  if (!job || job.phase !== "collecting") return { profile: cleared, job, phase: "ok" };
  const next = { ...job, phase: "interrupted" as const, result: "interrupted" as const, stopReason: "restart" };
  return { profile: replace(cleared, next), job: next, phase: "ok" };
}
