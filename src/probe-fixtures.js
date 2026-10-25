// One-shot check that the fixtures feed works and the venue matching is right.
//   npm run fixtures
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { fetchFixtures, activeFixtures, haversineKm } from "./matchday.js";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const cfgPath = fs.existsSync(path.join(ROOT, "config.json"))
  ? path.join(ROOT, "config.json") : path.join(ROOT, "config.example.json");
const config = JSON.parse(fs.readFileSync(cfgPath, "utf8"));

const cfg = config.matchdays;
if (!cfg?.enabled) { console.log("matchdays disabled in config"); process.exit(0); }

console.log("Venues:", cfg.venues.map((v) => v.label).join(", "));
console.log("Teams: ", [...new Set(cfg.venues.flatMap((v) => v.teams))].join(", "));
console.log("");

const fixtures = await fetchFixtures(cfg, path.join(ROOT, "data", "fixtures.json"));

if (!fixtures.length) {
  console.log("No upcoming home fixtures found at those venues.");
  console.log("If that looks wrong, the free '123' key is shared and rate limited — try again in a minute.");
  process.exit(0);
}

for (const f of fixtures) {
  const ko = new Date(f.kickoff);
  const km = haversineKm({ lat: f.lat, lon: f.lon }, config.home).toFixed(1);
  console.log(`${ko.toLocaleString("en-GB")}  ${f.home} v ${f.away}`);
  console.log(`   ${f.venue}  ${km}km from home  ${f.league}`);
}

console.log("\nWhich would show right now:");
const active = activeFixtures(fixtures, cfg, config.home, config.destinations);
console.log(active.length
  ? active.map((f) => `  ${f.home} v ${f.away} — affects [${f.affects.join(", ") || "nothing"}]`).join("\n")
  : "  none (nothing inside the alert window)");

console.log("\nCorridor test against each destination:");
for (const f of fixtures.slice(0, 3)) {
  const r = activeFixtures([{ ...f, kickoff: new Date().toISOString() }], cfg, config.home, config.destinations);
  console.log(`  ${f.venue.padEnd(14)} -> [${r[0]?.affects.join(", ") || "nothing"}]`);
}
