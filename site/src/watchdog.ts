import type { Env } from "./env";
import { loadStats } from "./data";

// A daily check, run by the cron trigger, that emails the operator when the
// site needs a hand: data that stopped refreshing, a backup that stopped
// arriving, a refresh whose stages failed, a daily post that X or Bluesky
// refused, a Zenodo deposit, search database sync or audience roll-up that
// failed, or a deploy the run rolled back because the site answered with
// server errors after it. The run's notices (a government notice first listed
// that night, IRCC's high-wage list adopted or unreadable, a designated-employer
// list or a news feed that changed state) are information, not alerts: the
// email carries them in a section of their own, and a morning with notices and
// no alert still sends one, with a subject that says notices.
// It reads only what the nightly run leaves behind (the stats file, the
// backup's timestamp, status.json in R2), so a run that never happened is
// caught as well as one that failed. Sending goes through Cloudflare's email
// binding to a destination verified in the zone's Email Routing; with no
// binding or no address the check still runs and only logs.

export const DATA_STALE_HOURS = 36;
export const BACKUP_STALE_HOURS = 36;
const HOUR = 60 * 60 * 1000;

export type RunStatus = {
  run_at?: string;
  ok?: boolean;
  x_post?: string;
  bluesky_post?: string;
  zenodo_deposit?: string;
  search_sync?: string;
  views_rollup?: string;
  search_console?: string;
  views_report?: string;
  deploy_rolled_back?: boolean;
  stages?: { source: string; ok: boolean; detail?: string }[];
  // Information from the run that is not a failure (status.json "notices"); never an alert.
  notices?: { source: string; detail: string }[];
};

export type Inputs = {
  now: Date;
  dataAsOf: string | null; // YYYY-MM-DD from stats.json, or null when missing
  backupUploaded: Date | null; // lmia.sqlite.gz uploaded time in R2
  status: RunStatus | null; // status.json from R2
  statusProblem?: string | null; // why status.json could not be read in full
};

// status.json is written by the workflow, so its shape is checked here rather
// than trusted: a field of the wrong type must produce an alert, never an
// exception that stops the check from sending anything. A stage entry that
// cannot be read counts as a failed stage.
export function readStatus(raw: unknown): { status: RunStatus | null; problem: string | null } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { status: null, problem: "The run status (status.json) in R2 is not a JSON object." };
  }
  const r = raw as Record<string, unknown>;
  const unreadable: string[] = [];
  const status: RunStatus = {};
  if (typeof r.run_at === "string" && !Number.isNaN(Date.parse(r.run_at))) status.run_at = r.run_at;
  else unreadable.push("run_at");
  if (typeof r.ok === "boolean") status.ok = r.ok;
  if (typeof r.x_post === "string") status.x_post = r.x_post;
  if (typeof r.bluesky_post === "string") status.bluesky_post = r.bluesky_post;
  if (typeof r.zenodo_deposit === "string") status.zenodo_deposit = r.zenodo_deposit;
  if (typeof r.search_sync === "string") status.search_sync = r.search_sync;
  if (typeof r.views_rollup === "string") status.views_rollup = r.views_rollup;
  if (typeof r.search_console === "string") status.search_console = r.search_console;
  if (typeof r.views_report === "string") status.views_report = r.views_report;
  // Only a real true counts: a rollback alert from a field of the wrong type
  // would send the operator after a deploy that never happened.
  if (typeof r.deploy_rolled_back === "boolean") status.deploy_rolled_back = r.deploy_rolled_back;
  if (Array.isArray(r.stages)) {
    status.stages = r.stages.map((s) => {
      if (!s || typeof s !== "object") return { source: "unknown", ok: false, detail: "unreadable stage entry" };
      const e = s as Record<string, unknown>;
      return {
        source: typeof e.source === "string" ? e.source : "unknown",
        ok: e.ok === true,
        detail: typeof e.detail === "string" ? e.detail : undefined,
      };
    });
  } else if (r.stages !== undefined) {
    unreadable.push("stages");
  }
  // A notice that cannot be read is dropped rather than alerted on: it is
  // advice, and the stages above already alert on anything that failed.
  if (Array.isArray(r.notices)) {
    status.notices = r.notices.flatMap((n) => {
      if (!n || typeof n !== "object") return [];
      const e = n as Record<string, unknown>;
      return typeof e.detail === "string" && e.detail ? [{ source: typeof e.source === "string" ? e.source : "notice", detail: e.detail }] : [];
    });
  }
  const problem = unreadable.length
    ? `The run status (status.json) in R2 has unreadable fields (${unreadable.join(", ")}).`
    : null;
  return { status, problem };
}

export function collectAlerts(i: Inputs): string[] {
  const out: string[] = [];
  if (!i.dataAsOf) {
    out.push("The site has no data file (stats.json is missing): the pages show Data Not Published Yet.");
  } else {
    const age = (i.now.getTime() - Date.parse(`${i.dataAsOf}T00:00:00Z`)) / HOUR;
    if (Number.isNaN(age)) {
      out.push(`The data date in stats.json (${String(i.dataAsOf).slice(0, 40)}) is not a date.`);
    } else if (age > DATA_STALE_HOURS + 24) {
      out.push(`The data is dated ${i.dataAsOf}, ${Math.floor(age / 24)} days old: the nightly refresh has not published since.`);
    }
  }
  if (i.statusProblem) out.push(i.statusProblem);
  if (!i.backupUploaded) {
    out.push("No database backup (lmia.sqlite.gz) is in R2.");
  } else if ((i.now.getTime() - i.backupUploaded.getTime()) / HOUR > BACKUP_STALE_HOURS) {
    out.push(`The database backup in R2 was last saved ${i.backupUploaded.toISOString().slice(0, 16)} UTC, more than ${BACKUP_STALE_HOURS} hours ago.`);
  }
  if (!i.status) {
    out.push("No run status (status.json) is in R2: the nightly workflow has not completed a run with the current version.");
  } else {
    if (i.status.run_at && (i.now.getTime() - Date.parse(i.status.run_at)) / HOUR > DATA_STALE_HOURS) {
      out.push(`The last completed run was ${i.status.run_at.slice(0, 16)} UTC.`);
    }
    for (const s of i.status.stages ?? []) {
      if (!s.ok) out.push(`Stage "${s.source}" failed in the last run${s.detail ? `: ${s.detail.slice(0, 160)}` : ""}.`);
    }
    if (i.status.x_post === "failed" || i.status.x_post === "no credentials") {
      out.push(`The daily X post did not go out (${i.status.x_post}). Check the credits in the X developer console and the run log.`);
    } else if (i.status.x_post === "unverified") {
      out.push("X answered the daily post with an error and its account could not be read afterwards. Check the account: the post is recorded as made so no run repeats it.");
    }
    if (i.status.bluesky_post === "failed" || i.status.bluesky_post === "no credentials") {
      out.push(`The daily Bluesky post did not go out (${i.status.bluesky_post}). Check the app password in the BSKY_APP_PASSWORD secret and the run log.`);
    }
    if (i.status.zenodo_deposit === "failed") {
      out.push("The Zenodo deposit of the new ESDC quarter failed. The next run tries again; check the ZENODO_TOKEN secret and the run log.");
    }
    if (i.status.search_sync === "failed") {
      out.push("The search database sync failed. The next run sends the same changes again; check the run log.");
    }
    if (i.status.views_rollup === "failed") {
      out.push("The audience roll-up failed. The next run catches up; check the CLOUDFLARE_ANALYTICS_TOKEN secret and the run log.");
    }
    if (i.status.search_console === "failed") {
      out.push("The Search Console import failed. The next run catches up; check the GSC_SERVICE_ACCOUNT_JSON secret and the run log.");
    }
    if (i.status.views_report === "failed") {
      out.push("The monthly audience report was not written. The next run tries again; check the run log.");
    }
    if (i.status.deploy_rolled_back === true) {
      out.push("The site answered with server errors after the last deploy, so the run rolled the Worker back to the version before it. The site shows the previous data until a later run deploys again; check the run log.");
    }
  }
  return out;
}

// A government notice carries its full title and link, so a notice may be long.
export const NOTICE_CHARS = 1200;

// The last run's notices, one line each. Only from a run recent enough to be
// the last night's: an older status is an alert of its own, and its notices
// went out the morning after it.
export function collectNotices(i: Inputs): string[] {
  const runAt = i.status?.run_at;
  if (!runAt) return [];
  const age = (i.now.getTime() - Date.parse(runAt)) / HOUR;
  if (!(age >= 0 && age <= DATA_STALE_HOURS)) return [];
  return (i.status?.notices ?? []).map((n) => `${n.source}: ${n.detail.slice(0, NOTICE_CHARS)}`);
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function buildEmail(from: string, to: string, alerts: string[], now: Date, notices: string[] = []): string {
  const subject = alerts.length
    ? `LMIA Watch: ${plural(alerts.length, "item")} need attention${notices.length ? `, ${plural(notices.length, "notice")}` : ""}`
    : `LMIA Watch: ${plural(notices.length, "notice")} from the last run`;
  const when = `Daily check at ${now.toISOString().slice(0, 16)} UTC`;
  const lines = [
    ...(alerts.length ? [`${when} found:`, "", ...alerts.map((a, n) => `${n + 1}. ${a}`)] : [`${when}: nothing needs attention.`]),
    ...(notices.length
      ? ["", "Notices from the last run (information; nothing failed):", "", ...notices.map((n) => `- ${n}`)]
      : []),
    "",
    "Run log: https://github.com/AggreCan/lmia-watch/actions",
    "Site: https://lmiawatch.ca/data",
    "",
    alerts.length
      ? "This message is sent by the site's own daily check; it repeats each day while an item remains."
      : "This message is sent by the site's own daily check when the last run recorded notices.",
  ];
  return [
    `From: LMIA Watch <${from}>`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Date: ${now.toUTCString()}`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "",
    ...lines,
  ].join("\r\n");
}

export async function gatherInputs(env: Env, now: Date): Promise<Inputs> {
  const stats = await loadStats(env).catch(() => null);
  let backupUploaded: Date | null = null;
  let status: RunStatus | null = null;
  const problems: string[] = [];
  if (env.DATA) {
    try {
      const head = await env.DATA.head("lmia.sqlite.gz");
      backupUploaded = head ? head.uploaded : null;
    } catch (e) {
      backupUploaded = null;
      problems.push(`The data bucket (R2) could not be read: ${String(e).slice(0, 120)}`);
    }
    try {
      const obj = await env.DATA.get("status.json");
      if (obj) {
        const read = readStatus(JSON.parse(await obj.text()));
        status = read.status;
        if (read.problem) problems.push(read.problem);
      }
    } catch (e) {
      status = null;
      problems.push(`The run status (status.json) in R2 could not be read: ${String(e).slice(0, 120)}`);
    }
  }
  const raw = stats?.data_as_of;
  const dataAsOf = typeof raw === "string" ? raw : raw == null ? null : String(raw);
  return { now, dataAsOf, backupUploaded, status, statusProblem: problems.join(" ") || null };
}

export async function runWatchdog(
  env: Env, now: Date = new Date(),
): Promise<{ alerts: string[]; notices: string[]; sent: boolean; error?: string }> {
  const inputs = await gatherInputs(env, now);
  const alerts = collectAlerts(inputs);
  const notices = collectNotices(inputs);
  if (alerts.length === 0 && notices.length === 0) return { alerts, notices, sent: false };
  const counts = `${alerts.length} alert(s), ${notices.length} notice(s)`;
  const to = (env.ALERT_EMAIL ?? "").trim();
  const from = (env.ALERT_FROM ?? "").trim();
  if (!env.ALERTS || !to || !from) {
    console.log(`watchdog: ${counts}, no email binding or address configured`);
    return { alerts, notices, sent: false };
  }
  try {
    const { EmailMessage } = await import("cloudflare:email");
    await env.ALERTS.send(new EmailMessage(from, to, buildEmail(from, to, alerts, now, notices)));
    console.log(`watchdog: ${counts}, email sent`);
    return { alerts, notices, sent: true };
  } catch (e) {
    console.log(`watchdog: ${counts}, email failed: ${String(e).slice(0, 200)}`);
    return { alerts, notices, sent: false, error: String(e).slice(0, 300) };
  }
}
