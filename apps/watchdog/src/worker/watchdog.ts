import { dispatchWorkflow, listWorkflowRuns, rerunWorkflow } from "./github";
import type { Env, GuardRecord, GithubWorkflowRun } from "./types";

const ACTIVE_STATUSES = new Set(["queued", "in_progress", "waiting", "pending", "requested"]);
const RETRYABLE_CONCLUSIONS = new Set([
  "failure",
  "cancelled",
  "timed_out",
  "action_required",
  "startup_failure",
]);
const RELEVANT_EVENTS = new Set(["schedule", "workflow_dispatch"]);

export interface GuardCheckResult {
  guardId: string;
  status: string;
  action?: "rerun" | "dispatch";
  runId?: number;
  message?: string;
}

export async function runScheduledWatchdog(env: Env): Promise<void> {
  const result = await env.DB.prepare(
    "SELECT * FROM guards WHERE enabled = 1 ORDER BY updated_at LIMIT 200",
  ).all<GuardRecord>();

  await Promise.allSettled(result.results.map((guard) => checkGuard(env, guard)));
}

export async function checkGuard(env: Env, guard: GuardRecord): Promise<GuardCheckResult> {
  const leaseAcquired = await acquireLease(env.DB, guard.id);
  if (!leaseAcquired) {
    return { guardId: guard.id, status: "locked" };
  }

  try {
    const now = new Date();
    const local = localDateParts(now, guard.timezone);
    const today = local.dateKey;
    const dueMinute = guard.expected_hour * 60 + guard.expected_minute + guard.grace_minutes;

    if (local.minuteOfDay < dueMinute) {
      await setStatus(env.DB, guard.id, "waiting", null, now);
      return {
        guardId: guard.id,
        status: "waiting",
        message: `Grace window has not elapsed in ${guard.timezone}`,
      };
    }

    const attemptsToday = guard.attempt_date === today ? guard.attempts_today : 0;
    const runs = await listWorkflowRuns(env, guard);
    const todayRuns = runs
      .filter((run) => RELEVANT_EVENTS.has(run.event))
      .filter((run) => run.head_branch === guard.ref)
      .filter((run) => localDateParts(new Date(run.created_at), guard.timezone).dateKey === today)
      .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));

    const success = todayRuns.find(
      (run) => run.status === "completed" && run.conclusion === "success",
    );
    if (success) {
      await env.DB.prepare(
        `UPDATE guards
         SET last_status = 'healthy', last_error = NULL, last_checked_at = ?,
             last_success_date = ?, attempts_today = 0, attempt_date = ?,
             updated_at = ?
         WHERE id = ?`,
      )
        .bind(now.toISOString(), today, today, now.toISOString(), guard.id)
        .run();
      return {
        guardId: guard.id,
        status: "healthy",
        runId: success.id,
      };
    }

    const active = todayRuns.find((run) => ACTIVE_STATUSES.has(run.status));
    if (active) {
      await setStatus(env.DB, guard.id, "running", null, now);
      return {
        guardId: guard.id,
        status: "running",
        runId: active.id,
      };
    }

    if (attemptsToday >= guard.max_attempts) {
      await setStatus(
        env.DB,
        guard.id,
        "exhausted",
        `Reached max attempts (${guard.max_attempts}) for ${today}`,
        now,
      );
      return {
        guardId: guard.id,
        status: "exhausted",
        message: `Reached max attempts (${guard.max_attempts})`,
      };
    }

    if (!cooldownElapsed(guard.last_action_at, guard.cooldown_minutes, now)) {
      await setStatus(env.DB, guard.id, "cooldown", null, now);
      return {
        guardId: guard.id,
        status: "cooldown",
      };
    }

    const retryable = todayRuns.find(isRetryableRun);
    const action = retryable ? "rerun" : "dispatch";

    if (retryable) {
      await rerunWorkflow(env, guard, retryable.id);
    } else {
      await dispatchWorkflow(env, guard);
    }

    const newAttempts = attemptsToday + 1;
    await env.DB.prepare(
      `UPDATE guards
       SET last_status = ?, last_error = NULL, last_checked_at = ?,
           last_action_at = ?, attempts_today = ?, attempt_date = ?, updated_at = ?
       WHERE id = ?`,
    )
      .bind(
        action === "rerun" ? "rerun_requested" : "dispatch_requested",
        now.toISOString(),
        now.toISOString(),
        newAttempts,
        today,
        now.toISOString(),
        guard.id,
      )
      .run();

    return {
      guardId: guard.id,
      status: action === "rerun" ? "rerun_requested" : "dispatch_requested",
      action,
      runId: retryable?.id,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await setStatus(env.DB, guard.id, "error", message.slice(0, 1500), new Date());
    return {
      guardId: guard.id,
      status: "error",
      message,
    };
  } finally {
    await releaseLease(env.DB, guard.id);
  }
}

function isRetryableRun(run: GithubWorkflowRun): boolean {
  return (
    run.status === "completed" &&
    run.conclusion !== null &&
    RETRYABLE_CONCLUSIONS.has(run.conclusion)
  );
}

function cooldownElapsed(lastActionAt: string | null, cooldownMinutes: number, now: Date): boolean {
  if (!lastActionAt) return true;
  const elapsed = now.getTime() - Date.parse(lastActionAt);
  return elapsed >= cooldownMinutes * 60_000;
}

function localDateParts(
  date: Date,
  timezone: string,
): {
  dateKey: string;
  minuteOfDay: number;
} {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
  const parts = Object.fromEntries(
    formatter
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  const hour = Number(parts.hour);
  const minute = Number(parts.minute);
  return {
    dateKey: `${parts.year}-${parts.month}-${parts.day}`,
    minuteOfDay: hour * 60 + minute,
  };
}

async function acquireLease(db: D1Database, guardId: string): Promise<boolean> {
  const now = new Date();
  const leaseUntil = new Date(now.getTime() + 5 * 60_000).toISOString();
  const result = await db
    .prepare(
      `UPDATE guards
       SET lease_until = ?
       WHERE id = ? AND (lease_until IS NULL OR lease_until < ?)`,
    )
    .bind(leaseUntil, guardId, now.toISOString())
    .run();
  return (result.meta.changes ?? 0) === 1;
}

async function releaseLease(db: D1Database, guardId: string): Promise<void> {
  await db.prepare("UPDATE guards SET lease_until = NULL WHERE id = ?").bind(guardId).run();
}

async function setStatus(
  db: D1Database,
  guardId: string,
  status: string,
  error: string | null,
  now: Date,
): Promise<void> {
  await db
    .prepare(
      `UPDATE guards
       SET last_status = ?, last_error = ?, last_checked_at = ?, updated_at = ?
       WHERE id = ?`,
    )
    .bind(status, error, now.toISOString(), now.toISOString(), guardId)
    .run();
}
