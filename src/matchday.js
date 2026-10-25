import fs from "node:fs";
import path from "node:path";

const V1 = "https://www.thesportsdb.com/api/v1/json";

// ---------- geometry ----------
const R = 6371; // km
const rad = (d) => (d * Math.PI) / 180;

export function haversineKm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}

/**
 * Shortest distance from a point to the straight line between two points.
 * Equirectangular projection is accurate enough over a city.
 * This is a crude stand-in for the real route, so keep the corridor generous.
 */
export function pointToSegmentKm(point, segStart, segEnd) {
  const lat0 = rad((segStart.lat + segEnd.lat) / 2);
  const toXY = (p) => ({ x: R * rad(p.lon) * Math.cos(lat0), y: R * rad(p.lat) });

  const p = toXY(point);
  const a = toXY(segStart);
  const b = toXY(segEnd);

  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;

  if (lenSq === 0) return Math.hypot(p.x - a.x, p.y - a.y);

  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t)); // clamp so we measure to the segment, not the infinite line

  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

// ---------- fixture fetching ----------
async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "home-board" } });
  if (!res.ok) throw new Error(`thesportsdb ${res.status}`);
  const text = await res.text();
  if (!text.trim()) return null; // the free tier sometimes returns an empty body
  try { return JSON.parse(text); } catch { throw new Error("bad json from thesportsdb"); }
}

async function resolveTeamId(key, name, cache) {
  if (cache.teams[name]) return cache.teams[name];
  const data = await getJson(`${V1}/${key}/searchteams.php?t=${encodeURIComponent(name)}`);
  const teams = data?.teams || [];
  // prefer an exact name match; the search is fuzzy and returns near misses
  const hit =
    teams.find((t) => (t.strTeam || "").toLowerCase() === name.toLowerCase()) ||
    teams.find((t) => (t.strTeam || "").toLowerCase().includes(name.toLowerCase()));
  if (!hit?.idTeam) return null;
  cache.teams[name] = hit.idTeam;
  return hit.idTeam;
}

function kickoffIso(ev) {
  if (ev.strTimestamp) {
    // already UTC, just normalise the separator
    const t = ev.strTimestamp.replace(" ", "T");
    return t.endsWith("Z") ? t : t + "Z";
  }
  if (ev.dateEvent && ev.strTime) return `${ev.dateEvent}T${ev.strTime}Z`;
  if (ev.dateEvent) return `${ev.dateEvent}T15:00:00Z`; // no time given, assume an afternoon kickoff
  return null;
}

function venueFor(ev, venues) {
  const home = (ev.strHomeTeam || "").toLowerCase();
  const stadium = (ev.strVenue || "").toLowerCase();

  for (const v of venues) {
    if ((v.teams || []).some((t) => t.toLowerCase() === home)) return v;
  }
  // fall back to the stadium name in case a cup tie lists an unfamiliar home side
  for (const v of venues) {
    if (stadium && stadium.includes(v.label.toLowerCase())) return v;
  }
  return null;
}

/**
 * Fetch upcoming fixtures for every team named in the venue config.
 * The free tier returns a small number of events per team, so we ask per team
 * rather than per league and merge the results.
 */
export async function fetchFixtures(cfg, cachePath) {
  const key = cfg.apiKey || "123";
  const venues = cfg.venues || [];

  let cache = { teams: {} };
  try { cache = JSON.parse(fs.readFileSync(cachePath, "utf8")); } catch {}
  if (!cache.teams) cache.teams = {};

  const names = [...new Set(venues.flatMap((v) => v.teams || []))];
  const events = new Map();

  for (const name of names) {
    try {
      const id = await resolveTeamId(key, name, cache);
      if (!id) continue;
      const data = await getJson(`${V1}/${key}/eventsnext.php?id=${id}`);
      for (const ev of data?.events || []) {
        if (ev.idEvent) events.set(ev.idEvent, ev);
      }
    } catch (err) {
      // one bad team shouldn't kill the rest
      console.error(`[matchday] ${name}: ${err.message}`);
    }
  }

  fs.mkdirSync(path.dirname(cachePath), { recursive: true });
  fs.writeFileSync(cachePath, JSON.stringify(cache, null, 2));

  const fixtures = [];
  for (const ev of events.values()) {
    const venue = venueFor(ev, venues);
    if (!venue) continue; // away game, or somewhere we don't care about
    const kickoff = kickoffIso(ev);
    if (!kickoff) continue;

    fixtures.push({
      id: ev.idEvent,
      home: ev.strHomeTeam,
      away: ev.strAwayTeam,
      league: ev.strLeague || "",
      venueId: venue.id,
      venue: venue.label,
      lat: venue.lat,
      lon: venue.lon,
      kickoff
    });
  }

  fixtures.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  return fixtures;
}

// ---------- relevance ----------
/**
 * Work out which fixtures are close enough in time to matter, and which
 * destinations they sit near. Returns fixtures annotated with `affects`.
 */
export function activeFixtures(fixtures, cfg, home, destinations, now = Date.now()) {
  const out = [];

  for (const f of fixtures) {
    // a venue can override the defaults: some grounds sit right on your route
    const v = (cfg.venues || []).find((x) => x.id === f.venueId) || {};
    const before = (v.alertFromHoursBefore ?? cfg.alertFromHoursBefore ?? 4) * 3600000;
    const after = (v.alertUntilHoursAfter ?? cfg.alertUntilHoursAfter ?? 2.5) * 3600000;
    const corridor = v.corridorKm ?? cfg.corridorKm ?? 4;
    const severity = v.severity || "normal";

    const ko = new Date(f.kickoff).getTime();
    if (Number.isNaN(ko)) continue;
    if (now < ko - before || now > ko + after) continue;

    const venue = { lat: f.lat, lon: f.lon };
    const affects = [];

    for (const d of destinations) {
      const alongRoute = pointToSegmentKm(venue, home, { lat: d.lat, lon: d.lon });
      const atDestination = haversineKm(venue, { lat: d.lat, lon: d.lon });
      if (alongRoute <= corridor || atDestination <= corridor) affects.push(d.id);
    }

    const fromHome = haversineKm(venue, home);

    out.push({
      ...f,
      affects,
      severity,
      nearHomeKm: Number(fromHome.toFixed(1)),
      phase: now < ko ? "before" : "after"
    });
  }

  return out;
}
