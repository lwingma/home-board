// Concerts and arena events from Ticketmaster Discovery.
//
// Deliberately emits the same shape as matchday.js's fetchFixtures, so activeFixtures()
// and every bit of the corridor geometry are reused untouched. The only football-specific
// things there are fetchFixtures and venueFor; the relevance maths doesn't care.

const TM = "https://app.ticketmaster.com/discovery/v2/events.json";

// Ticketmaster lists most events twice: the real listing, and a "Venue Premium - <name>"
// upsell twin at an identical start time. Strip the prefix for display.
const PREMIUM = /^\s*venue premium\s*-\s*/i;

// Ticketmaster's own throttle is 5 requests/second and it answers 429 well before that
// in practice, so space the venue calls out. Six venues costs about a second, once every
// six hours.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function startIso(ev) {
  const s = ev.dates?.start;
  if (!s) return null;
  // an announced-but-unscheduled event has no usable time; a 4-hour alert window
  // around a guessed kickoff would be worse than showing nothing
  if (s.dateTBD || s.dateTBA || s.timeTBA || s.noSpecificTime) return null;
  return s.dateTime || null; // already UTC with a trailing Z, unlike TheSportsDB
}

async function getJson(url) {
  const res = await fetch(url, { headers: { "User-Agent": "home-board" } });
  if (!res.ok) throw new Error(`ticketmaster ${res.status}`);
  return res.json();
}

/**
 * Upcoming events at the configured venues that are big enough to move traffic.
 *
 * Queries per venue rather than by radius on purpose: a 15km radius around home
 * returns ~45 events a fortnight, nearly all of them 300-capacity bars, and the
 * corridor test alone can't tell those apart from a 14,000-seat arena. Ticketmaster
 * exposes no capacity field, so the curated list in config is what carries that.
 */
export async function fetchEvents(cfg, apiKey, horizonDays = 3) {
  if (!apiKey) throw new Error("no TICKETMASTER_API_KEY");

  const min = cfg.minCapacity ?? 0;
  const venues = (cfg.venues || []).filter((v) => v.tmVenueId && (v.capacity ?? 0) >= min);

  const now = new Date();
  const end = new Date(now.getTime() + horizonDays * 86400000);
  const stamp = (d) => d.toISOString().slice(0, 19) + "Z";

  const out = [];
  let first = true;

  for (const v of venues) {
    if (!first) await sleep(250);
    first = false;
    try {
      const url = new URL(TM);
      url.searchParams.set("apikey", apiKey);
      url.searchParams.set("venueId", v.tmVenueId);
      url.searchParams.set("startDateTime", stamp(now));
      url.searchParams.set("endDateTime", stamp(end));
      url.searchParams.set("size", "50");
      url.searchParams.set("sort", "date,asc");

      const data = await getJson(url);
      const seen = new Set();

      for (const ev of data?._embedded?.events || []) {
        const kickoff = startIso(ev);
        if (!kickoff) continue;

        const title = String(ev.name || "").replace(PREMIUM, "").trim();
        if (!title) continue;

        // One entry per venue per start time. Matching on the title too looks safer but
        // isn't: the same show gets listed under punctuation variants ("Hilary Duff - the
        // lucky me tour" and "Hilary Duff: the lucky me tour" at one instant), and both
        // survive a title-aware key. For a traffic warning, one row per venue-slot is
        // the right granularity anyway.
        if (seen.has(kickoff)) continue;
        seen.add(kickoff);

        out.push({
          id: ev.id,
          kind: "event",
          title,
          league: ev.classifications?.[0]?.segment?.name || "",
          venueId: v.id,
          venue: v.label,
          lat: v.lat,
          lon: v.lon,
          kickoff
        });
      }
    } catch (err) {
      // one bad venue shouldn't blank the others
      console.error(`[events] ${v.label}: ${err.message}`);
    }
  }

  out.sort((a, b) => new Date(a.kickoff) - new Date(b.kickoff));
  return out;
}
