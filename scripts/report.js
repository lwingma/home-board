// Reads what the board has recorded and checks it against the thresholds it has to
// earn its place by. No dependencies, nothing written.
//
//   npm run report
//
// Sources: data/events.jsonl (src/server.js logEvent), data/capture/*.jsonl (raw
// Open-Meteo and TomTom responses), data/reminders.json, and the watchdog log.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "data");
const configPath = fs.existsSync(path.join(ROOT, "config.json"))
  ? path.join(ROOT, "config.json")
  : path.join(ROOT, "config.example.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const TZ = config.timezone;
const PEOPLE = config.reminders?.people || [];

const T = {
  completion: 0.70,       // done within 7 days
  secondPerson: 0.25,     // share of reminders added by the second person
  morning: 0.995,         // board answering 07:00-10:00 while the PC is on
  rainHit: 0.80,          // rain onsets warned >= 15 min ahead
  rainFalse: 0.20         // "rain from" sentences that didn't come true
};

const MIN = 60000;
const DAY = 24 * 60 * MIN;
// REPORT_NOW=2026-11-01T00:00Z reports as of a past moment, for re-reading a finished window
const now = process.env.REPORT_NOW ? Date.parse(process.env.REPORT_NOW) : Date.now();

// ---------- read ----------
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

const events = readJsonl(path.join(DATA, "events.jsonl"))
  .map((e) => ({ ...e, ms: Date.parse(e.t) }))
  .sort((a, b) => a.ms - b.ms);

let reminders = [];
try { reminders = JSON.parse(fs.readFileSync(path.join(DATA, "reminders.json"), "utf8")); } catch {}

const captureDir = path.join(DATA, "capture");
const captures = (prefix) => fs.existsSync(captureDir)
  ? fs.readdirSync(captureDir).filter((f) => f.startsWith(prefix)).sort()
      .flatMap((f) => readJsonl(path.join(captureDir, f)))
  : [];

// ---------- helpers ----------
const fmt = new Intl.DateTimeFormat("en-CA", {
  timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23", weekday: "short"
});
function local(ms) {
  const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { iso: `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`, hour: Number(p.hour), weekday: p.weekday };
}
// Open-Meteo times are naive local; compare them as if they were UTC
const naive = (s) => Date.parse(s + ":00Z");

const pct = (x) => (x * 100).toFixed(1) + "%";
const median = (xs) => {
  if (!xs.length) return null;
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;

function verdict(value, ok, enough) {
  if (!enough) return "NOT ENOUGH DATA";
  return ok(value) ? "PASS" : "FAIL";
}

const out = [];
const line = (s = "") => out.push(s);
const row = (label, value, target, v) => line(`  ${label.padEnd(44)} ${String(value).padEnd(16)} ${target.padEnd(12)} ${v}`);

// ---------- header ----------
const first = events[0];
line("Home Board report");
line(`  events since ${first ? first.t.slice(0, 16).replace("T", " ") : "(none yet)"} UTC, ` +
  `${events.length} lines, ${first ? ((now - first.ms) / DAY).toFixed(1) : 0} days`);
line();
line(`  ${"metric".padEnd(44)} ${"value".padEnd(16)} ${"target".padEnd(12)} verdict`);

// ---------- 1. reminders ----------
line();
line("Reminders");

const remEvents = events.filter((e) => e.type === "reminder");
const created = remEvents.filter((e) => e.action === "create");

// completion: only reminders created since logging began and at least 7 days ago,
// so each has had a full week. Older ones are survivors — the done ones were pruned
// before anything recorded them — and would bias the rate down.
const cohort = created.filter((c) => now - c.ms >= 7 * DAY);
let doneIn7 = 0;
for (const c of cohort) {
  let done = false;
  for (const e of remEvents) {
    if (e.id !== c.id || e.ms > c.ms + 7 * DAY) continue;
    if (e.action === "done") done = true;
    if (e.action === "undone") done = false;
    if (e.action === "delete") done = !!e.wasDone || done;
  }
  if (done) doneIn7++;
}
const compRate = cohort.length ? doneIn7 / cohort.length : 0;
row("done within 7 days", cohort.length ? `${pct(compRate)} (${doneIn7}/${cohort.length})` : "-",
  ">= 70%", verdict(compRate, (x) => x >= T.completion, cohort.length >= 5));

const open = reminders.filter((r) => !r.doneAt);
const ages = open.map((r) => (now - Date.parse(r.createdAt)) / DAY);
const medAge = median(ages);
row("median age of open reminders", medAge === null ? "-" : medAge.toFixed(1) + " days",
  "< 7 days", verdict(medAge, (x) => x < 7, open.length > 0));

const second = PEOPLE[1];
const byPerson = {};
for (const c of created) byPerson[c.by || "(nobody)"] = (byPerson[c.by || "(nobody)"] || 0) + 1;
const secondShare = created.length ? (byPerson[second] || 0) / created.length : 0;
row(`added by ${second || "second person"}`, created.length ? `${pct(secondShare)} (${byPerson[second] || 0}/${created.length})` : "-",
  ">= 25%", verdict(secondShare, (x) => x >= T.secondPerson, created.length >= 10));

line(`  added by person      ${Object.entries(byPerson).map(([k, v]) => `${k} ${v}`).join(" · ") || "-"}`);
const bySrc = {};
for (const c of created) bySrc[c.src || "?"] = (bySrc[c.src || "?"] || 0) + 1;
line(`  added from           ${Object.entries(bySrc).map(([k, v]) => `${k} ${v}`).join(" · ") || "-"}`);
const ticked = remEvents.filter((e) => e.action === "done");
const tickSrc = {};
for (const e of ticked) tickSrc[e.src || "?"] = (tickSrc[e.src || "?"] || 0) + 1;
line(`  ticked off from      ${Object.entries(tickSrc).map(([k, v]) => `${k} ${v}`).join(" · ") || "-"}`);
const binnedUndone = remEvents.filter((e) => e.action === "delete" && !e.wasDone).length;
line(`  binned without being done  ${binnedUndone}`);
const openBy = {};
for (const r of open) openBy[r.by || "(nobody)"] = (openBy[r.by || "(nobody)"] || 0) + 1;
line(`  open now             ${open.length}: ${Object.entries(openBy).map(([k, v]) => `${k} ${v}`).join(" · ")}` +
  (open.length ? `, oldest ${Math.max(...ages).toFixed(0)} days` : ""));

// ---------- 2. morning availability ----------
// Every event proves the server was answering at that moment, and an "alive" lands
// every 5 minutes, so a gap over 6.5 minutes is downtime. A gap that ends in a
// "start" whose OS uptime is shorter than the gap means the PC itself was off for
// the part before the boot; that's reported separately, not counted against the board.
line();
line("Morning availability, 07:00-10:00 local");

const GAP = 6.5 * MIN;
const times = events.map((e) => e.ms);
function stateAt(x) {
  // binary search: index of first event after x
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] <= x) lo = mid + 1; else hi = mid; }
  const prev = lo > 0 ? events[lo - 1] : null;
  const next = lo < events.length ? events[lo] : null;
  if (!prev) return null;                                 // before logging began
  const nextMs = next ? next.ms : now;
  if (nextMs - prev.ms <= GAP) return "up";
  if (!next) return "down";
  // the start event can sit a few ms behind the flag events logged at module load
  const start = events.slice(lo, lo + 20).find((e) => e.type === "start" && e.ms - next.ms < MIN);
  if (start && typeof start.uptimeSec === "number") {
    const boot = start.ms - start.uptimeSec * 1000;
    if (x < boot) return "pc-off";
    if (start.uptimeSec < 900) return "starting";          // booted, board not up yet
  }
  return "down";
}

const morning = { up: 0, down: 0, starting: 0, "pc-off": 0 };
const downMornings = new Set();
if (first) {
  for (let x = Math.ceil(first.ms / MIN) * MIN; x < now; x += MIN) {
    const l = local(x);
    if (l.hour < 7 || l.hour >= 10) continue;
    const s = stateAt(x);
    if (!s) continue;
    morning[s]++;
    if (s === "down") downMornings.add(l.iso.slice(0, 10));
  }
}
// The verdict leaves out the minute or so between boot and the board answering: that's
// startup, shown on its own line, not the board failing.
const onMins = morning.up + morning.down;
const avail = onMins ? morning.up / onMins : 0;
row("answering while the PC is on", onMins ? pct(avail) : "-", ">= 99.5%", verdict(avail, (x) => x >= T.morning, onMins >= 3 * 60 * 7));
const withStart = onMins + morning.starting;
if (morning.starting) line(`  same, counting startup       ${pct(morning.up / withStart)}`);
const allMins = withStart + morning["pc-off"];
line(`  minutes up / down / starting / PC off   ${morning.up} / ${morning.down} / ${morning.starting} / ${morning["pc-off"]}` +
  (allMins ? `  (PC off ${pct(morning["pc-off"] / allMins)} of the window)` : ""));
if (downMornings.size) line(`  mornings with board downtime   ${[...downMornings].join(", ")}`);
const boots = events.filter((e) => e.type === "start" && e.uptimeSec < 900).map((e) => e.uptimeSec);
if (boots.length) line(`  boot to board answering    median ${median(boots)}s over ${boots.length} boots`);
const crashes = events.filter((e) => e.type === "start" && e.uptimeSec >= 900).length;
line(`  restarts not caused by a boot   ${crashes}`);

const wdLog = path.join(process.env.LOCALAPPDATA || "", "home-board-watchdog.log");
if (first && fs.existsSync(wdLog)) {
  const since = local(first.ms).iso.replace("T", " ");
  const lines = fs.readFileSync(wdLog, "utf8").split(/\r?\n/).map((s) => s.replace(/^﻿/, ""))
    .filter((s) => s.slice(0, 16) >= since && /restarted 'Home Board'/.test(s));
  line(`  watchdog restarts of the board  ${lines.length}`);
}

// ---------- 3. rain sentence ----------
// Truth is Open-Meteo's own 15-minute slot as reported while that slot was current:
// the shortest-lead nowcast, not a rain gauge. Good enough to tell a sentence that
// fires on time from one that cries wolf.
line();
line("Rain sentence");

const truth = new Map();   // naive local slot start -> mm
for (const c of captures("open-meteo-")) {
  const m = c.data?.minutely_15;
  if (!m?.time) continue;
  const at = local(Date.parse(c.t)).iso;
  for (let i = 0; i < m.time.length; i++) {
    const start = m.time[i];
    const end = new Date(naive(start) + 15 * MIN).toISOString().slice(0, 16);
    if (start <= at && at < end) { truth.set(start, m.precipitation[i] ?? 0); break; }
  }
}
const slots = [...truth.keys()].sort();
const WET = 0.1;
const onsets = slots.filter((s) => {
  const prev = new Date(naive(s) - 15 * MIN).toISOString().slice(0, 16);
  return truth.get(s) >= WET && truth.has(prev) && truth.get(prev) < WET;
});

const weatherPolls = events.filter((e) => e.type === "poll" && e.api === "weather" && e.ok && e.rain);
const soon = weatherPolls.filter((e) => e.rain.state === "soon").map((e) => ({ at: local(e.ms).iso, startsAt: e.rain.startsAt }));

let hits = 0;
for (const o of onsets) {
  const ok = soon.some((p) => naive(p.at) <= naive(o) - 15 * MIN && Math.abs(naive(p.startsAt) - naive(o)) <= 30 * MIN);
  if (ok) hits++;
}
const hitRate = onsets.length ? hits / onsets.length : 0;
row("onsets warned 15+ min ahead", onsets.length ? `${pct(hitRate)} (${hits}/${onsets.length})` : "-",
  ">= 80%", verdict(hitRate, (x) => x >= T.rainHit, onsets.length >= 5));

// one "rain from 14:30" repeated over several polls is one claim
const claims = [...new Set(soon.map((p) => p.startsAt))];
let verifiable = 0, falseAlarms = 0;
for (const s of claims) {
  const window = slots.filter((x) => Math.abs(naive(x) - naive(s)) <= 30 * MIN);
  if (window.length < 4) continue;                       // not enough truth around it
  verifiable++;
  if (!window.some((x) => truth.get(x) >= WET)) falseAlarms++;
}
const far = verifiable ? falseAlarms / verifiable : 0;
row("\"rain from\" that didn't happen", verifiable ? `${pct(far)} (${falseAlarms}/${verifiable})` : "-",
  "<= 20%", verdict(far, (x) => x <= T.rainFalse, verifiable >= 5));

const stateCount = {};
for (const e of weatherPolls) stateCount[e.rain.state] = (stateCount[e.rain.state] || 0) + 1;
line(`  sentence shown       ${Object.entries(stateCount).map(([k, v]) => `${k} ${v}`).join(" · ") || "-"}`);
line(`  truth slots          ${slots.length} (${slots.filter((s) => truth.get(s) >= WET).length} wet)`);

// ---------- 4. match-day traffic ----------
// Compare each flagged sample with unflagged samples for the same route at the same
// weekday and hour. If flagged days aren't measurably worse, the chip is noise.
line();
line("Match and event traffic");

const samples = events.filter((e) => e.type === "poll" && e.api === "traffic" && e.routes)
  .flatMap((e) => {
    const l = local(e.ms);
    return e.routes.filter((r) => typeof r.delayMinutes === "number")
      .map((r) => ({ id: r.id, delay: r.delayMinutes, match: r.match, key: `${r.id}|${l.weekday}|${l.hour}` }));
  });
const baseline = new Map();
for (const s of samples) if (!s.match) (baseline.get(s.key) || baseline.set(s.key, []).get(s.key)).push(s.delay);

const flagged = samples.filter((s) => s.match);
const paired = flagged.filter((s) => baseline.has(s.key));
const fMean = mean(paired.map((s) => s.delay));
const bMean = mean(paired.map((s) => mean(baseline.get(s.key))));
// keyed on what and when, not id: Ticketmaster has handed one show two ids in a day
const flags = new Map();
for (const e of events.filter((e) => e.type === "flag")) flags.set(`${e.label}|${e.kickoff}`, e);

row("delay on flagged vs normal slots", paired.length ? `+${fMean.toFixed(1)} vs +${bMean.toFixed(1)} min` : "-",
  "clear gap", paired.length >= 12 ? (fMean - bMean >= 2 ? "PASS" : "FAIL") : "NOT ENOUGH DATA");
line(`  flagged samples      ${flagged.length}, ${paired.length} with a same-weekday-and-hour baseline`);
for (const id of [...new Set(paired.map((s) => s.id))]) {
  const p = paired.filter((s) => s.id === id);
  line(`    ${id.padEnd(16)} +${mean(p.map((s) => s.delay)).toFixed(1)} vs +${mean(p.map((s) => mean(baseline.get(s.key)))).toFixed(1)} min over ${p.length}`);
}
line(`  distinct flags       ${flags.size}${flags.size ? ": " + [...flags.values()].map((f) => `${f.label} (${f.kickoff.slice(0, 10)})`).join(" · ") : ""}`);

// ---------- 5. polls ----------
line();
line("Feeds");
const polls = events.filter((e) => e.type === "poll" && e.api !== "usage");
const byApi = {};
for (const p of polls) {
  const a = byApi[p.api] || (byApi[p.api] = { ok: 0, fail: 0, last: null });
  if (p.ok) a.ok++; else { a.fail++; a.last = p.error; }
}
for (const [api, a] of Object.entries(byApi)) {
  line(`  ${api.padEnd(20)} ${pct(a.ok / (a.ok + a.fail))} ok (${a.fail} failed${a.last ? ", last: " + a.last : ""})`);
}
const usage = events.filter((e) => e.type === "poll" && e.api === "usage");
if (usage.length) line(`  ${"usage scraper".padEnd(20)} ${usage.filter((e) => !e.ok).length} drop-outs`);

console.log(out.join("\n"));
