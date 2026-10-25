import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { fetchFixtures, activeFixtures } from "./matchday.js";
import { fetchEvents } from "./events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");

// ---------- config ----------
const configPath = fs.existsSync(path.join(ROOT, "config.json"))
  ? path.join(ROOT, "config.json")
  : path.join(ROOT, "config.example.json");

const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
const TOMTOM_KEY = process.env.TOMTOM_API_KEY || "";
const TICKETMASTER_KEY = process.env.TICKETMASTER_API_KEY || "";
const API_TOKEN = process.env.HOMEBOARD_TOKEN || config.apiToken || "";

if (!TOMTOM_KEY) {
  console.warn("[warn] TOMTOM_API_KEY not set. Traffic will report as unavailable.");
}
if (config.events?.enabled && !TICKETMASTER_KEY) {
  console.warn("[warn] TICKETMASTER_API_KEY not set. Concerts and arena events will not show.");
}

// ---------- reminders store ----------
const DATA_DIR = path.join(ROOT, "data");
const STORE = path.join(DATA_DIR, "reminders.json");
fs.mkdirSync(DATA_DIR, { recursive: true });

// ---------- measurement ----------
// An append-only record of what the board did and what people did with it, read by
// scripts/report.js. Before this, a ticked reminder was deleted by pruneReminders 12h
// later and nothing remembered it existed, so reminders.json only ever held the ones
// that hadn't been done. Never throws: a full disk must not take the board down.
const EVENTS = path.join(DATA_DIR, "events.jsonl");

function logEvent(type, fields = {}) {
  try {
    fs.appendFileSync(EVENTS, JSON.stringify({ t: new Date().toISOString(), type, ...fields }) + "\n");
  } catch (err) {
    console.error("[events]", err.message);
  }
}

// Raw API responses, one JSONL file per source per day, so the rain sentence and the
// match-day corridor can be replayed against what actually happened. Time-boxed by
// config.capture.until (a local date, inclusive): measured at ~0.6MB a day.
const CAPTURE_DIR = path.join(DATA_DIR, "capture");

function capture(source, body) {
  const until = config.capture?.until;
  if (!until) return;
  const day = localNowIso(config.timezone).slice(0, 10);
  if (day > until) return;
  try {
    fs.mkdirSync(CAPTURE_DIR, { recursive: true });
    fs.appendFileSync(
      path.join(CAPTURE_DIR, `${source}-${day}.jsonl`),
      JSON.stringify({ t: new Date().toISOString(), ...body }) + "\n"
    );
  } catch (err) {
    console.error("[capture]", err.message);
  }
}

// Which page a reminder change came from: the board and the add page tag their calls,
// anything untagged (an iOS Shortcut, curl) is "api".
function sourceOf(url) {
  const s = url.searchParams.get("src") || "";
  return /^[a-z]{1,16}$/.test(s) ? s : "api";
}

function loadReminders() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return [];
  }
}

// The array's own order is the order the board draws, so dragging a row is just
// a rewrite of this list. `order` is written alongside it purely so the file is
// readable and so a client can sort defensively; the array is the truth.
function resequence(list) {
  list.forEach((r, i) => { r.order = i; });
  return list;
}

function saveReminders(list) {
  fs.writeFileSync(STORE, JSON.stringify(resequence(list), null, 2));
}

// Reminders written before drag-to-rearrange existed have no `order`. Seed it
// from the order the board was already showing them in — done last, newest
// first — so nothing jumps the first time this runs. After that the stored
// order stands on its own and ticking an item no longer moves it.
function seedOrder(list) {
  if (list.length && list.every((r) => typeof r.order === "number")) return list;
  return list.slice().sort((a, b) => {
    if (!!a.doneAt !== !!b.doneAt) return a.doneAt ? 1 : -1;
    return new Date(b.createdAt) - new Date(a.createdAt);
  });
}

// drop completed items after the configured window so the board self-cleans
function pruneReminders(list) {
  const cutoff = Date.now() - (config.reminders?.keepDoneHours ?? 12) * 3600000;
  return list.filter((r) => !r.doneAt || new Date(r.doneAt).getTime() > cutoff);
}

let reminders = seedOrder(pruneReminders(loadReminders()));
saveReminders(reminders);

// ---------- state ----------
const state = {
  weather: null,
  traffic: [],
  matchday: [],
  usage: null,
  updated: { weather: null, traffic: null, fixtures: null, events: null, usage: null },
  errors: {}
};

let fixtures = [];
let events = [];
const FIXTURE_CACHE = path.join(DATA_DIR, "fixtures.json");
const EVENT_LIST = path.join(DATA_DIR, "events-list.json");

try {
  const saved = JSON.parse(fs.readFileSync(path.join(DATA_DIR, "fixtures-list.json"), "utf8"));
  if (Array.isArray(saved)) fixtures = saved;
} catch {}

try {
  const saved = JSON.parse(fs.readFileSync(EVENT_LIST, "utf8"));
  if (Array.isArray(saved)) events = saved;
} catch {}

async function fetchMatchdays() {
  const cfg = config.matchdays;
  if (!cfg?.enabled) return;
  fixtures = await fetchFixtures(cfg, FIXTURE_CACHE);
  fs.writeFileSync(path.join(DATA_DIR, "fixtures-list.json"), JSON.stringify(fixtures, null, 2));
  state.updated.fixtures = Date.now();
  delete state.errors.matchdays;
  logEvent("poll", { api: "matchdays", ok: true, count: fixtures.length });
}

async function fetchEventList() {
  const cfg = config.events;
  if (!cfg?.enabled || !TICKETMASTER_KEY) return;
  events = await fetchEvents(cfg, TICKETMASTER_KEY);
  fs.writeFileSync(EVENT_LIST, JSON.stringify(events, null, 2));
  state.updated.events = Date.now();
  delete state.errors.eventlist;
  logEvent("poll", { api: "eventlist", ok: true, count: events.length });
}

// Logged on change only — refreshMatchdayState runs every minute. A restart logs the
// active ones again; report.js dedupes on id.
const flagsSeen = new Map();

function logFlagChanges(list) {
  const now = new Set();
  for (const f of list) {
    now.add(f.id);
    if (flagsSeen.get(f.id) === f.phase) continue;
    flagsSeen.set(f.id, f.phase);
    logEvent("flag", {
      id: f.id, kind: f.kind || "match",
      label: f.title || `${f.home} v ${f.away}`, venue: f.venue,
      kickoff: f.kickoff, phase: f.phase, severity: f.severity || null, affects: f.affects
    });
  }
  for (const id of flagsSeen.keys()) {
    if (!now.has(id)) { flagsSeen.delete(id); logEvent("flag-end", { id }); }
  }
}

// Football and concerts share one list: both carry lat/lon and a kickoff, so the same
// corridor and alert-window maths applies to each. Each gets its own config block
// because a 14k arena gig and a 50k derby need different windows.
function refreshMatchdayState() {
  const list = [];
  if (config.matchdays?.enabled) {
    list.push(...activeFixtures(fixtures, config.matchdays, config.home, config.destinations));
  }
  if (config.events?.enabled) {
    list.push(...activeFixtures(events, config.events, config.home, config.destinations));
  }
  list.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  state.matchday = list;
  logFlagChanges(list);
}

const nowHour = () => Number(
  new Intl.DateTimeFormat("en-GB", { hour: "numeric", hour12: false, timeZone: config.timezone })
    .format(new Date())
);

const isActiveWindow = () => {
  const h = nowHour();
  const { start, end } = config.activeHours;
  return start <= end ? h >= start && h < end : h >= start || h < end;
};

// ---------- rain outlook ----------
// Open-Meteo returns naive local timestamps, so compare against a naive local now.
function localNowIso(tz) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(new Date());
  const g = (t) => parts.find((x) => x.type === t).value;
  return `${g("year")}-${g("month")}-${g("day")}T${g("hour")}:${g("minute")}`;
}

const WET = 0.1; // mm in a 15-minute slot before it counts as rain

function rainOutlook(minutely, tz) {
  if (!minutely?.time?.length) return null;

  const now = localNowIso(tz);

  // start from the slot that CONTAINS now, not the next one to begin
  let from = -1;
  for (let i = 0; i < minutely.time.length; i++) {
    if (minutely.time[i] <= now) from = i; else break;
  }
  if (from === -1) from = minutely.time.findIndex((t) => t >= now);
  if (from === -1) return null;

  const slots = [];
  for (let i = from; i < minutely.time.length; i++) {
    slots.push({ time: minutely.time[i], mm: minutely.precipitation[i] ?? 0 });
  }
  const window = slots.slice(0, 25); // the current slot plus six hours
  if (!window.length) return null;
  // a stale feed leaves only past timestamps; don't report on it
  if (window[window.length - 1].time < now) return null;

  const horizonEnd = window[window.length - 1].time;
  const wetAt = (i) => window[i] && window[i].mm >= WET;

  if (wetAt(0)) {
    // already raining: find the first dry slot that stays dry for 30 minutes
    let endsAt = null;
    for (let i = 1; i < window.length - 1; i++) {
      if (!wetAt(i) && !wetAt(i + 1)) { endsAt = window[i].time; break; }
    }
    const peak = Math.max(...window.filter((s) => s.mm >= WET).map((s) => s.mm));
    return { state: "raining", endsAt, horizonEnd, intensity: intensityOf(peak) };
  }

  const startIdx = window.findIndex((s) => s.mm >= WET);
  if (startIdx === -1) return { state: "dry", horizonEnd };

  let peak = 0;
  for (let i = startIdx; i < window.length && window[i].mm >= WET; i++) peak = Math.max(peak, window[i].mm);
  return { state: "soon", startsAt: window[startIdx].time, horizonEnd, intensity: intensityOf(peak) };
}

function intensityOf(mmPerQuarter) {
  const perHour = mmPerQuarter * 4;
  if (perHour < 2.5) return "light";
  if (perHour < 7.6) return "moderate";
  return "heavy";
}

// ---------- weather (Open-Meteo, no key needed) ----------
async function fetchWeather() {
  const { lat, lon } = config.home;
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  url.searchParams.set("latitude", lat);
  url.searchParams.set("longitude", lon);
  url.searchParams.set(
    "current",
    "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,wind_direction_10m,is_day"
  );
  url.searchParams.set("hourly", "temperature_2m,precipitation_probability,weather_code");
  url.searchParams.set("minutely_15", "precipitation");
  url.searchParams.set("forecast_minutely_15", "48");
  url.searchParams.set(
    "daily",
    "weather_code,temperature_2m_max,temperature_2m_min,sunrise,sunset,precipitation_probability_max,uv_index_max"
  );
  url.searchParams.set("wind_speed_unit", config.units.wind === "mph" ? "mph" : "kmh");
  url.searchParams.set("timezone", config.timezone);
  url.searchParams.set("forecast_days", "2");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`open-meteo ${res.status}`);
  const data = await res.json();
  capture("open-meteo", { data });

  // hourly.time is naive local (we pass timezone=), so compare against a naive local now.
  // toISOString() here would be UTC and start the strip an hour in the past through BST.
  const nowIso = localNowIso(config.timezone).slice(0, 13);
  const startIdx = Math.max(0, data.hourly.time.findIndex((t) => t.slice(0, 13) >= nowIso));
  const hourly = data.hourly.time.slice(startIdx, startIdx + 8).map((t, i) => ({
    time: t,
    temp: data.hourly.temperature_2m[startIdx + i],
    pop: data.hourly.precipitation_probability[startIdx + i]
  }));

  state.weather = {
    temp: data.current.temperature_2m,
    feels: data.current.apparent_temperature,
    humidity: data.current.relative_humidity_2m,
    code: data.current.weather_code,
    isDay: data.current.is_day === 1,
    wind: data.current.wind_speed_10m,
    gust: data.current.wind_gusts_10m,
    windDir: data.current.wind_direction_10m,
    high: data.daily.temperature_2m_max[0],
    low: data.daily.temperature_2m_min[0],
    sunrise: data.daily.sunrise[0],
    sunset: data.daily.sunset[0],
    uv: data.daily.uv_index_max[0],
    rainChance: data.daily.precipitation_probability_max[0],
    rain: rainOutlook(data.minutely_15, config.timezone),
    hourly
  };
  state.updated.weather = Date.now();
  delete state.errors.weather;
  logEvent("poll", { api: "weather", ok: true, rain: state.weather.rain });
}

// ---------- claude code usage ----------
// Read from the separate xeneon-claude-usage scraper, which already serves this on
// 127.0.0.1:7878. That process is optional and often not running, so a failure here
// is not an error state: it just means the block doesn't appear. Deliberately never
// throws, so it can't reach the board's error bar. Logged on change only.
let usageWasOk = null;

async function fetchUsage() {
  const cfg = config.claudeUsage;
  if (!cfg?.enabled) { state.usage = null; return; }
  try {
    const res = await fetch(cfg.url);
    if (!res.ok) throw new Error(String(res.status));
    const d = await res.json();
    // the scraper writes nulls when it can't read a meter; only show real numbers
    if (typeof d?.session !== "number" && typeof d?.weekAll !== "number") throw new Error("no numbers");
    state.usage = d;
    state.updated.usage = Date.now();
    if (usageWasOk !== true) logEvent("poll", { api: "usage", ok: true });
    usageWasOk = true;
  } catch (err) {
    state.usage = null;
    if (usageWasOk !== false) logEvent("poll", { api: "usage", ok: false, error: String(err.message || err) });
    usageWasOk = false;
  }
}

// ---------- traffic (TomTom Routing) ----------
// We already poll every few minutes, so keep an hour of it and read the direction.
const history = new Map();
const TREND_MIN = 2; // minutes of change before it's worth reporting

function recordDelay(id, delayMinutes) {
  const now = Date.now();
  const list = (history.get(id) || []).filter((s) => now - s.t < 75 * 60000);
  list.push({ t: now, delay: delayMinutes });
  history.set(id, list);
}

function trendFor(id, currentDelay) {
  const now = Date.now();
  const past = (history.get(id) || [])
    .filter((s) => now - s.t >= 20 * 60000 && now - s.t <= 60 * 60000)
    .map((s) => s.delay)
    .sort((a, b) => a - b);

  if (past.length < 2) return null; // not enough history yet

  const mid = Math.floor(past.length / 2);
  const baseline = past.length % 2 ? past[mid] : (past[mid - 1] + past[mid]) / 2;
  const change = currentDelay - baseline;

  if (change >= TREND_MIN) return "worsening";
  if (change <= -TREND_MIN) return "clearing";
  return "steady";
}

// Free-flow is the speed-limit ideal: no lights, no junctions, no turns. A completely
// empty road still measures ~8% over it, and that baseline scales with trip length,
// so an absolute cutoff calls a long quiet drive "busy" while missing a short jammed one.
// Judge proportionally. Measured live on a commute into a city centre:
// empty road 7-9%, 3am 0%, weekday 08:30 35%, weekday 17:30 39%. So both rush hours
// land in "busy" and "heavy" is reserved for worse than a normal rush hour.
function statusFor(delaySeconds, freeSeconds) {
  if (!freeSeconds) return "clear";
  const ratio = delaySeconds / freeSeconds;
  if (ratio < 0.18) return "clear";
  if (ratio < 0.45) return "busy";
  return "heavy";
}

async function routeFor(dest) {
  const { lat, lon } = config.home;
  const loc = `${lat},${lon}:${dest.lat},${dest.lon}`;
  const url = new URL(`https://api.tomtom.com/routing/1/calculateRoute/${loc}/json`);
  url.searchParams.set("key", TOMTOM_KEY);
  url.searchParams.set("traffic", "true");
  url.searchParams.set("computeTravelTimeFor", "all");
  url.searchParams.set("routeType", "fastest");
  url.searchParams.set("travelMode", dest.mode || "car");

  const res = await fetch(url);
  if (!res.ok) throw new Error(`tomtom ${res.status}`);
  const data = await res.json();
  const s = data.routes?.[0]?.summary;
  if (!s) throw new Error("no route");
  // the summary only: the full response carries every route point, ~50KB a call
  capture("tomtom", { id: dest.id, summary: s });

  // travelTimeInSeconds is the traffic-aware time when traffic=true.
  // liveTrafficIncidentsTravelTimeInSeconds counts incidents ONLY (roadworks, accidents)
  // and reads 0 delay through ordinary rush hour, so it's the wrong basis for a commute board.
  const live = s.travelTimeInSeconds;
  const free = s.noTrafficTravelTimeInSeconds ?? s.travelTimeInSeconds;
  const delay = Math.max(0, live - free);
  const miles = s.lengthInMeters / 1609.34;
  const delayMinutes = Math.round(delay / 60);

  recordDelay(dest.id, delayMinutes);

  return {
    id: dest.id,
    label: dest.label,
    sub: dest.sub || "",
    minutes: Math.round(live / 60),
    delayMinutes,
    trend: trendFor(dest.id, delayMinutes),
    distance: config.units.distance === "miles"
      ? Number(miles.toFixed(1))
      : Number((s.lengthInMeters / 1000).toFixed(1)),
    arriveAt: new Date(Date.now() + live * 1000).toISOString(),
    status: statusFor(delay, free)
  };
}

async function fetchTraffic() {
  if (!TOMTOM_KEY) {
    state.errors.traffic = "No TOMTOM_API_KEY";
    logEvent("poll", { api: "traffic", ok: false, error: "no key" });
    return;
  }
  const results = [];
  for (const dest of config.destinations) {
    try {
      results.push(await routeFor(dest));
    } catch (err) {
      results.push({ id: dest.id, label: dest.label, sub: dest.sub || "", error: String(err.message || err) });
    }
  }
  refreshMatchdayState();
  const affected = new Map();
  for (const f of state.matchday) {
    for (const id of f.affects) {
      const cur = affected.get(id);
      // a high-severity cause always wins the chip, whatever got there first
      if (!cur || (f.severity === "high" && cur.severity !== "high")) {
        affected.set(id, { severity: f.severity, kind: f.kind || "match" });
      }
    }
  }
  for (const r of results) {
    const a = affected.get(r.id);
    if (a) { r.match = true; r.matchSeverity = a.severity; r.matchKind = a.kind; }
  }

  state.traffic = results;
  state.updated.traffic = Date.now();
  // Clear the key every() would have set if a previous run threw. Without this a
  // single transient failure leaves the coral error bar across the top of the board
  // until the next restart, however many polls succeed after it. It has to be here
  // rather than in every(): the no-key branch above sets this same key deliberately
  // and returns without throwing, so a blanket clear in every() would wipe it.
  delete state.errors.traffic;
  logEvent("poll", {
    api: "traffic",
    ok: results.some((r) => !r.error),
    routes: results.map((r) => r.error
      ? { id: r.id, error: r.error }
      : { id: r.id, minutes: r.minutes, delayMinutes: r.delayMinutes, status: r.status,
          match: !!r.match, matchSeverity: r.matchSeverity || null, matchKind: r.matchKind || null })
  });
}

// ---------- schedulers ----------
/* The boot run ignores activeHours. Without that, a restart after the window closes
   starts with state.traffic empty and no way to fill it until 06:00 — the watchdog
   restarting the board at 23:07 left the departures column blank all night, which
   reads as broken rather than resting. One TomTom call per restart is nothing. */
function every(minutes, fn, respectActiveHours = false) {
  const run = async (isBootRun = false) => {
    if (respectActiveHours && !isBootRun && !isActiveWindow()) return;
    try {
      await fn();
    } catch (err) {
      console.error(`[${fn.name}]`, err.message);
      const api = fn.name.replace("fetch", "").toLowerCase();
      state.errors[api] = String(err.message || err);
      logEvent("poll", { api, ok: false, error: String(err.message || err) });
    }
  };
  run(true);
  /* setInterval passes no argument, so every later run gates on activeHours normally. */
  return setInterval(run, minutes * 60 * 1000);
}

every(config.refreshMinutes.weather, fetchWeather);
every(config.refreshMinutes.fixtures ?? 360, fetchMatchdays);
every(config.refreshMinutes.events ?? 360, fetchEventList);
every(config.refreshMinutes.usage ?? 5, fetchUsage);
refreshMatchdayState();
setInterval(refreshMatchdayState, 60000);
every(config.refreshMinutes.traffic, fetchTraffic, true);
setInterval(() => { reminders = pruneReminders(reminders); saveReminders(reminders); }, 30 * 60 * 1000);

// Proof of life for report.js. A gap in these, read against the next "start" event's
// OS uptime, says whether the board was down or the whole PC was off.
setInterval(() => logEvent("alive"), 5 * 60 * 1000);

// ---------- helpers ----------
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml"
};

function json(res, code, body) {
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 10000) req.destroy();
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error("bad json")); }
    });
    req.on("error", reject);
  });
}

// Only enforced if a token is configured. Local network use needs none.
function authed(req, url) {
  if (!API_TOKEN) return true;
  const header = req.headers.authorization || "";
  return header === `Bearer ${API_TOKEN}` || url.searchParams.get("token") === API_TOKEN;
}

function lanAddress() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === "IPv4" && !n.internal) return n.address;
    }
  }
  return "127.0.0.1";
}

// ---------- server ----------
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const p = url.pathname;

  if (p === "/api/data") {
    return json(res, 200, {
      home: config.home.label,
      units: config.units,
      people: config.reminders?.people || [],
      activeHours: config.activeHours,   // the board says when traffic resumes, not "no data"
      addUrl: `http://${lanAddress()}:${config.port}/add`,
      reminders,
      ...state,
      serverTime: new Date().toISOString()
    });
  }

  if (p === "/api/refresh") {
    await Promise.allSettled([fetchWeather(), fetchTraffic(), fetchUsage()]);
    return json(res, 200, { ok: true });
  }

  // --- reminders ---
  if (p === "/api/reminders" && req.method === "GET") {
    return json(res, 200, { reminders });
  }

  if (p === "/api/reminders" && req.method === "POST") {
    if (!authed(req, url)) return json(res, 401, { error: "unauthorised" });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: "bad json" }); }

    // Shortcuts sends plain text easily, so accept `text` or `note`
    const text = String(body.text ?? body.note ?? "").trim().slice(0, 200);
    if (!text) return json(res, 400, { error: "text required" });

    const item = {
      id: crypto.randomUUID(),
      text,
      by: String(body.by || "").trim().slice(0, 32) || null,
      createdAt: new Date().toISOString(),
      doneAt: null
    };
    reminders.unshift(item);
    saveReminders(reminders);
    logEvent("reminder", { action: "create", id: item.id, by: item.by, src: sourceOf(url), text: item.text });
    return json(res, 201, item);
  }

  // Takes the full id list in its new order. Ids it doesn't recognise are
  // dropped and ids it wasn't sent keep their relative places at the end, so a
  // reorder racing an add or a delete can't lose a reminder.
  if (p === "/api/reminders/reorder" && req.method === "POST") {
    if (!authed(req, url)) return json(res, 401, { error: "unauthorised" });
    let body;
    try { body = await readBody(req); } catch { return json(res, 400, { error: "bad json" }); }
    if (!Array.isArray(body.ids)) return json(res, 400, { error: "ids array required" });

    const left = new Map(reminders.map((r) => [r.id, r]));
    const next = [];
    for (const id of body.ids) {
      const item = left.get(id);
      if (item) { next.push(item); left.delete(id); }
    }
    for (const r of reminders) if (left.has(r.id)) next.push(r);

    reminders = next;
    saveReminders(reminders);
    logEvent("reminder", { action: "reorder", src: sourceOf(url), ids: reminders.map((r) => r.id) });
    return json(res, 200, { ok: true, reminders });
  }

  const toggle = p.match(/^\/api\/reminders\/([\w-]+)\/toggle$/);
  if (toggle && req.method === "POST") {
    if (!authed(req, url)) return json(res, 401, { error: "unauthorised" });
    const item = reminders.find((r) => r.id === toggle[1]);
    if (!item) return json(res, 404, { error: "not found" });
    item.doneAt = item.doneAt ? null : new Date().toISOString();
    saveReminders(reminders);
    logEvent("reminder", {
      action: item.doneAt ? "done" : "undone", id: item.id, by: item.by,
      createdAt: item.createdAt, src: sourceOf(url)
    });
    return json(res, 200, item);
  }

  const del = p.match(/^\/api\/reminders\/([\w-]+)$/);
  if (del && req.method === "DELETE") {
    if (!authed(req, url)) return json(res, 401, { error: "unauthorised" });
    const gone = reminders.find((r) => r.id === del[1]);
    reminders = reminders.filter((r) => r.id !== del[1]);
    saveReminders(reminders);
    if (gone) {
      logEvent("reminder", {
        action: "delete", id: gone.id, by: gone.by, createdAt: gone.createdAt,
        wasDone: !!gone.doneAt, src: sourceOf(url)
      });
    }
    return json(res, 200, { ok: true });
  }

  // --- static ---
  let rel = p === "/" ? "/index.html" : p === "/add" ? "/add.html" : p;
  const file = path.join(ROOT, "public", path.normalize(rel).replace(/^(\.\.[/\\])+/, ""));

  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
    res.end(buf);
  });
});

server.listen(config.port, "0.0.0.0", () => {
  // uptime tells report.js whether this start followed a boot or a crash
  logEvent("start", { uptimeSec: Math.round(os.uptime()), pid: process.pid });
  const lan = lanAddress();
  console.log(`Board       http://127.0.0.1:${config.port}`);
  console.log(`Add page    http://${lan}:${config.port}/add   <- bookmark this on your phones`);
  console.log(`Data        http://127.0.0.1:${config.port}/api/data`);
});
