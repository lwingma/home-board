# Home Board

Three columns on a 2560x720 strip: weather, live drive times, shared reminders. Auto-scales to any screen, so it works in a browser now and on a wall tablet later.

A small Node service polls the APIs, holds the reminders, and serves both pages. The frontend is a dumb renderer.

## What you need

- **Node 22.9 or newer** (nodejs.org). There are no npm dependencies, so there's nothing to install beyond Node itself.
- **A free TomTom key** for drive times. **A free Ticketmaster key** too if you want concerts and arena events. Weather needs no key.
- **Windows**, for the autostart scripts and the iCUE widget. The server itself is plain Node and runs anywhere, and the board works in any browser.
- Optional: a **Corsair Xeneon Edge** with iCUE and Corsair's `icuewidget` CLI (from the iCUE WidgetBuilder Kit), to run it as a widget on the screen.

## Preview

Open `public/index.html?demo` in a browser to see the layout filled with sample data. Without `?demo`, and with no server running, it shows empty `--` placeholders: it never makes up data.

## Setup

1. **TomTom key.** developer.tomtom.com, free tier, no card.

2. **Config:**
   ```
   cp config.example.json config.json
   ```
   Set `home.lat/lon` and fill in `destinations`. The example uses public Glasgow landmarks as placeholders. Right-click a spot in Google Maps to copy its coordinates. Set `reminders.people` to the names you want on the add page, and `timezone` and `units` to suit.

   The match-day and concert venues are Glasgow's. If you live elsewhere, set `matchdays.enabled` and `events.enabled` to `false`, or swap in your own grounds and venues (see [Match days](#match-days)).

3. **Keys:**
   ```
   cp .env.example .env
   ```
   Fill in `TOMTOM_API_KEY`, and `TICKETMASTER_API_KEY` if you want concerts. `npm start` loads `.env` itself via Node's `--env-file-if-exists`, so nothing else is needed. `.env` is gitignored.

4. **Run:**
   ```
   npm start
   ```

On boot it prints three URLs. Open the first, `http://127.0.0.1:7879`, to see the board. The one to keep is the **add page** on your LAN address: bookmark it on your phones.

## Running unattended

Two scheduled tasks, both **at logon** for the current user, both with no execution time limit (the Windows default kills a task after 3 days) and 3 restarts at 5-minute intervals:

| Task | Starts | Log |
| --- | --- | --- |
| `Home Board` | this server on :7879, +10s after logon | `%LOCALAPPDATA%\home-board.log` |
| `Claude Usage Scraper` | xeneon-claude-usage on :7878, +30s | `%LOCALAPPDATA%\claude-usage-scraper.log` |

At logon rather than at startup, and interactive rather than "run whether logged on or not": the scraper drives real Chrome with `headless: false` and needs a desktop to draw into, and the board is only doing anything when someone is logged in for iCUE to render it. Nothing displays before logon anyway.

Install both with:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

Re-running it is safe — it replaces the tasks rather than duplicating them. **If you don't run the usage scraper (see [Claude Code usage](#claude-code-usage)), pass `-SkipScraper`.** That registers the board alone and stops the watchdog checking a scraper that isn't there. `-ScraperDir` points it at the scraper if it lives somewhere other than next to this folder.

It also registers **Home Board Watchdog**, which checks the board every five minutes and restarts it if it stops answering. It logs to `%LOCALAPPDATA%\home-board-watchdog.log`.

To inspect or remove:

```powershell
Get-ScheduledTask -TaskName "Home Board","Claude Usage Scraper"
Unregister-ScheduledTask -TaskName "Home Board" -Confirm:$false
```

## Reminders

The list lives in `data/reminders.json`. Nothing external, no account.

- **Board:** tap a row to tick it off. Or just start typing — any letter opens a composer, Enter adds it, Tab switches between the names in `reminders.people`, Escape cancels. There's no input box until you type, and it clears itself after 30 seconds of nothing.
- **Add page** (`/add`): type, pick who it's from, send. Tap to tick off, bin icon to delete.
- Completed items drop off after `reminders.keepDoneHours` (default 12).

Add it to your iPhone home screen (Share → Add to Home Screen) and it opens fullscreen like an app.

### iPhone Shortcut

For adding without opening anything. In Shortcuts, new shortcut:

1. **Ask for Input** → Text → prompt "Add to board"
2. **Get Contents of URL**
   - URL: `http://<your-lan-ip>:7879/api/reminders`
   - Method: POST
   - Request Body: JSON
   - Add field `text` (Text) → the Provided Input from step 1
   - Add field `by` (Text) → your name

Name it "Add to board" and Siri picks it up, so "Hey Siri, add to board" works. Add it to the home screen or the Lock Screen for a one-tap version.

To dictate straight in without the prompt, swap step 1 for **Dictate Text**.

### Off the home network

The add page and the Shortcut both need to reach the server, so by default they only work on your wifi. To use them from anywhere, put a Cloudflare tunnel in front of it and set `apiToken` in `config.json`. Once a token is set, POST/DELETE require `Authorization: Bearer <token>` (or `?token=`), which the Shortcut can send as a header.

### Typing on the Xeneon Edge

Tap empty space in the reminders column to open the composer, or just start typing with the board on screen. This works on the Edge as long as `widget/manifest.json` keeps `"interactive": true`. With `false`, iCUE delivers no taps or key presses to the widget at all.

If nothing happens, iCUE isn't giving the widget keyboard focus. The fallback is to open `http://127.0.0.1:7879` in a normal browser window on the same PC — identical page, same behaviour, same server, so anything added shows on the Edge within 15 seconds.

## Onto the Xeneon Edge

`widget/` is the iCUE bundle. It fetches `http://127.0.0.1:7879/api/data`, so the server has to be running. Keep it `127.0.0.1`, not `localhost`: `localhost` didn't reach the server from inside iCUE.

`widget/index.html` is a copy of `public/index.html`. After changing the board, copy it over, or the widget drifts.

Build it with Corsair's `icuewidget` CLI from the iCUE WidgetBuilder Kit. Don't zip the folder by hand: iCUE rejects it.

```
npm run widget:validate
npm run widget:package
```

That writes `homeboard.icuewidget` in the project root. Double-click it, or import it from iCUE's Widgets panel. **iCUE runs the copy it imported**, so after any change, repackage and import again. Editing `widget/` alone changes nothing on the screen.

Things iCUE is fussy about, all learned the hard way and already handled in these files:

- **The title must use the `tr()` form**, resolved via `translation.json`. A plain `<title>Home Board</title>` is rejected on import as "Missing title element". `document.title` is reset at runtime so a browser tab still reads properly.
- **`index.html` needs a `<link rel="icon">`** or the validator warns, and the served board 404s on every load.
- **Keep the Content-Security-Policy meta tag** in the head. Every widget iCUE accepted carried one, and its `connect-src *` is what lets the widget reach `127.0.0.1:7879`.
- **No HTML comment directly above `<title>`.** One containing its own `tr()` string confused the importer.

The page picks its API base by context: relative when served on port 7879, `http://127.0.0.1:7879` anywhere else. That's what lets one file serve the board, the LAN add page and the iCUE bundle, where a relative path would resolve against the bundle and never reach the server.

## Config

| Key | Notes |
| --- | --- |
| `port` | Leave it at `7879`. The board page and the widget both assume that port, so changing it breaks them. |
| `timezone` | IANA name, e.g. `Europe/London`. Weather times and the report use it. |
| `units` | `wind`: `mph` or `kmh`. `distance`: `miles` or `km`. `temperature` isn't read yet: the board is always Celsius. |
| `activeHours` | Traffic only polls in this window. Stops burning calls overnight. |
| `refreshMinutes` | Traffic 5, weather 15. |
| `destinations[].mode` | `car`, `bus`, `bicycle`, `pedestrian`, `motorcycle`, `van`, `truck`, `taxi` |
| `reminders.people` | Names shown on the add page. |
| `apiToken` | Blank = no auth (fine on a LAN). Set it if you expose the server. |
| `capture.until` | A date like `2026-11-01`. Until then, raw weather and traffic responses are saved to `data/capture/` (~0.6MB a day). Blank = off. |

## APIs

- **Weather: Open-Meteo.** Free, no key. Non-commercial use.
- **Traffic: TomTom Routing.** `computeTravelTimeFor=all` returns live and free-flow times; the delay figure is the difference between `travelTimeInSeconds` and `noTrafficTravelTimeInSeconds`.

  Free-flow is the speed-limit ideal, so even an empty road runs about 8% over it. The clear/busy/heavy badge is therefore a **percentage** of free-flow (18% / 45%), not a fixed number of minutes — an absolute cutoff labelled a quiet 24-minute drive "busy" while missing a short jammed one. Ignore `trafficDelayInSeconds`: it counts incidents only and reads 0 straight through rush hour.

Call maths: destinations x (active hours x 60 / interval). Three destinations, 6am–11pm, every 5 min = 612 calls a day. Free tier is 2,500.

## Match days

Rangers, Celtic, Scotland and Queen's Park home games at Ibrox, Celtic Park and Hampden. When one is on, a notice appears above the departures with the fixture and kickoff time, and any destination whose route passes within `corridorKm` of the ground gets a "match traffic" chip in place of its trend.

The window is `alertFromHoursBefore` (4) to `alertUntilHoursAfter` (2.5). Outside that, nothing shows.

Fixtures come from TheSportsDB on the free `123` key, refreshed every 6 hours and cached to `data/fixtures-list.json`, so a rate limit or an outage doesn't blank the board.

Check it's working:

```
npm run fixtures
```

That prints the upcoming home fixtures it found, how far each ground is from you, and which destinations each one would flag.

**Two caveats.** The `123` key is shared and rate limited, so if it comes back empty, try again in a minute. And the corridor is measured against a straight line from home to the destination, not the real driving route, which is why the default is a generous 4km. Narrow it if you get false alarms, widen it if a game doesn't flag a trip it should.

Each ground can override the defaults, because they don't all affect you equally:

| Key | Effect |
| --- | --- |
| `corridorKm` | How close the ground has to be to a route before it flags |
| `alertFromHoursBefore` | How early the notice appears |
| `alertUntilHoursAfter` | How long it lingers after kickoff |
| `severity` | `high` turns the notice and chips coral instead of amber |

In the example, Celtic Park is set to a 5.5km corridor, 5 hours' notice, and high severity. The other two use the defaults. Tune each ground for your own routes: a ground that sits right on your line into town deserves a wider corridor and more notice.

To add a ground, put it in `matchdays.venues` with its coordinates and the teams that play there. The team names must be how TheSportsDB spells them. Run `npm run fixtures` to check they resolve.

## Concerts and arena events

Same idea, same geometry, different feed. `events.venues` lists the big rooms — OVO Hydro, SEC, Hampden, Glasgow Green, Bellahouston — and a notice appears above the departures with an "event traffic" chip on any destination near one.

Needs a free key from developer.ticketmaster.com in `TICKETMASTER_API_KEY`. Without it the board just doesn't show events.

Each venue needs its Ticketmaster venue id in `tmVenueId`. To find one, search the Discovery API by name: `https://app.ticketmaster.com/discovery/v2/venues.json?keyword=<venue name>&apikey=<your key>`. The id is the `id` field of the matching venue.

Three things worth knowing, all found against live responses:

- **Ticketmaster exposes no capacity field.** `capacity` in the config is hardcoded per venue, and `minCapacity` (default 8000) is what stops a 300-seat bar firing the chip. Lower it and the board gets noisy fast: a 15km radius around Glasgow returns dozens of events a fortnight, nearly all of them tiny. That's why this queries a curated venue list rather than a radius.
- **Every event is listed twice**, once properly and once as `Venue Premium - <name>`. Deduped on venue plus start time, not on title — the same show appears under punctuation variants and a title-aware key lets both through.
- **Ibrox and Celtic Park sell no events through Ticketmaster**, so stadium concerts there won't appear. Hampden does.

The Hydro alone runs ~200 events a year against Rangers' ~25 home games, so on frequency this matters more than the football. Its default window is tighter than a matchday's (3h before, 2h after) because a 14k arena fills and empties faster than a 50k ground; Hampden, Glasgow Green and Bellahouston override back to 4h/2.5h.

## Claude Code usage

The status bar shows session and weekly usage meters on one line, coloured green / amber / coral at 70% and 90%. If the bar runs short of room, whole meters drop off from the right.

**Off by default** (`claudeUsage.enabled: false`). It doesn't scrape anything itself: it reads a JSON snapshot that a separate scraper serves on `127.0.0.1:7878/usage.json`. The original setup uses a companion project, **xeneon-claude-usage**, which isn't part of this repo. Anything that serves this shape works:

```json
{
  "session": 10, "weekAll": 14, "weekFable": 0, "weekOpus": null, "weekSonnet": null,
  "sessionResetText": "Resets in 3 hr 21 min", "weekResetText": "Resets Mon 2:30 AM",
  "scrapedAt": "2026-10-18T21:59:52.893Z"
}
```

Percentages are 0-100. Use `null` for any meter you don't have.

**If it isn't running the block simply doesn't appear** — no error, no empty panel, no entry in the error bar. That's deliberate: it's an optional side process, and a dead panel on a wall is worse than an empty space.

| Key | Notes |
| --- | --- |
| `claudeUsage.enabled` | `false` hides it entirely |
| `claudeUsage.url` | Where to read the snapshot from |
| `refreshMinutes.usage` | Default 5 |

Only meters the scraper actually returns are drawn, so `opus` and `sonnet` appear when they're populated and are skipped when null. Reset text is shortened for distance reading — "Resets in 3 hr 21 min" becomes "resets in 3h 21m".

## Is it earning its place?

The server keeps an append-only log in `data/events.jsonl`. It records:
- each reminder added, ticked or deleted, with who did it and from which page
- every feed check
- match and event flags
- a heartbeat every five minutes

```
npm run report
```

That checks the log against a few bars:
- reminders done within 7 days
- the share added by the second person
- the board answering in the mornings while the PC is on
- whether the rain sentence warns in time
- whether match-day flags line up with real delays

Below the data it needs, it says "not enough data" instead of guessing. `docs/tile-audit.md` is a template for deciding what each part of the board is for and what would justify keeping it.

## Theme

Three segments bottom right: auto, light, dark. Auto reads sunrise and sunset out of the weather feed, so the board goes light at sunrise and dark at sunset on its own, tracking the season without a schedule to maintain.

Dark mode is dark grey (`#121212` shell, `#1c1c1c` card) rather than pure black.
