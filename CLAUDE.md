# Home Board — working notes

A wall dashboard: weather, live drive times, shared reminders. Runs on a Corsair Xeneon Edge (2560x720) now, a wall tablet later.

## Shape of it

- `src/server.js` — polls APIs, holds reminders, serves both pages. Plain Node, no framework.
- `src/matchday.js` — football fixtures and route-proximity geometry.
- `src/events.js` — concerts and arena events from Ticketmaster. Emits the same shape as `fetchFixtures` so `activeFixtures` and all the corridor maths are reused; only the fetch differs.
- Claude Code usage is read from the **xeneon-claude-usage** project's server on `127.0.0.1:7878/usage.json`, not scraped here. `fetchUsage` in `server.js` never throws: if that process is down, `state.usage` goes null and the block hides. Don't route it through `every()`'s error handling — an optional side process being off is not a board error.
- `public/index.html` — the board. Self-contained, no build step.
- `public/add.html` — mobile page for adding reminders.
- `widget/` — iCUE bundle, a copy of index.html plus a manifest.
- `data/events.jsonl` — append-only log written by `logEvent` in `server.js`: reminder create/done/undone/delete/reorder with `by` and `src` (board, add, api), every poll's outcome, match/event flags on change, a `start` with OS uptime, and an `alive` every 5 minutes. `data/capture/` holds raw Open-Meteo responses and TomTom route summaries, one JSONL per source per day, until `config.capture.until`. Both started 2026-10-18.
- `scripts/report.js` (`npm run report`) — reads those and checks the thresholds the board has to earn its place by. `docs/tile-audit.md` says what each tile is for and what would justify keeping it.

**`widget/index.html` is a copy of `public/index.html`.** Change the latter and copy it over, or they drift.

No build, no bundler, no framework, and zero npm dependencies — only Node built-ins. `npm install` is a no-op. Keep it that way: it has to survive years of running unattended on a wall.

## Verified against live APIs (2026-08-02)

1. **Open-Meteo current + daily.** Works. Every assumed field name is correct.
2. **Rain sentence.** Works. `minutely_15` returns 48 slots anchored at the current time, local timestamps matching the `timezone` param. Only the `dry` branch has run against live data — the `raining` and `soon` branches are still unproven, so re-check on a wet day.
3. **TomTom delay.** Fixed, see below. Rows now show live ETAs and a proportional badge.

## iCUE: `interactive` gates every input

`manifest.json` must have `"interactive": true` or iCUE delivers **no pointer or keyboard events at all**. Confirmed on the Edge: with `false` the theme toggle did nothing, reminders couldn't be ticked, and type-to-add was dead. Flipping it to `true` fixed all three. The Claude Usage widget uses `false` only because it's read-only — don't copy that here.

With it on, **type-to-add works on the Edge** (2026-08-02). iCUE does forward key events to the widget. The document-level keydown listener was the right call; don't "fix" it by adding an `<input>`.

## Untested — check these first

1. **localStorage in iCUE.** Theme preference persists there. If it resets on reboot, move it into `config.json` and serve it from the Node side.
2. **Traffic trend arrows.** Observed working once (`– steady`) after the server had been up ~40 min. `trendFor` needs 20-60 minutes of poll history, so it reads `null` on a fresh boot — that's expected, not a fault.
3. **Rain `raining` / `soon` branches.** Only the `dry` branch has run against live data. Needs a wet day.
4. **TheSportsDB fixtures — known limits, see below.**

## Both scheduled tasks survive a real reboot (2026-08-02)

Verified on the Edge after an actual logon cycle, not just a cold manual run: the board and the usage scraper both came up on their own, and the widget rendered live weather, TomTom ETAs, usage from `127.0.0.1:7878` and reminders with no intervention.

## TheSportsDB: the free tier returns ONE event per team

Confirmed live, not rate limiting — HTTP 200 with a populated body, exactly one event each. Because that one event is the team's next fixture whether home or away, any team whose next game is away contributes nothing, and its next home game is invisible however soon it is. On 2026-08-02 only Celtic resolved, purely because Celtic happened to be home next; Rangers (away in Białystok) and Scotland (away in Slovenia) both vanished.

`eventsnext.php` cannot fix this. It needs a different endpoint — a full season schedule filtered to home games.

**Queen's Park never resolves at all.** `searchteams.php?t=Queen's Park` returns a single result: `Queens Park Rangers`, an English Championship club in London. `resolveTeamId`'s exact match fails and the `includes` fallback fails too — but only because the apostrophe in `"queen's park"` is absent from `"queens park rangers"`. Strip or normalise that apostrophe and the board starts tracking a club 400 miles away. Any fix here must match on `idTeam`, not on a normalised name.

## Decisions worth not re-litigating

- **Straight-line corridor for match days.** Real route geometry would be better but needs another API. The corridor is deliberately generous (4km default) to compensate. The example config overrides Celtic Park to 5.5km, 5 hours' notice and high severity, to show how one ground can matter more than the others. A destination that never flags at any threshold is a useful sanity check that the corridor isn't too wide.
- **Reminders are a local JSON file.** No account, no third party. Deliberate.
- **Type-to-add has no input element.** A page can lose focus in an embedded webview and still get key events. Don't "fix" this by adding an `<input>` and calling `.focus()`.
- **The 2560x720 stage is absolutely positioned and scaled**, not centred with flexbox. Centring an oversized child broke at small viewports. Don't revert it.
- **Fixed fetch order in `/api/data`.** The traffic poll recomputes match state before tagging rows, so severity is present when rows are built.
- **`demoData()` is reachable only via `?demo`.** It used to be the fetch-failure path. On 2026-08-07 the board sat all morning showing "Celtic v Hibernian, Celtic Park, on your route" — a match that did not exist — under a green pulsing dot, a fresh "updated 15:36" and a plausible "2m ago", because the server had been dead since 09:05 and every freshness signal was fabricated alongside the fixture. Never render invented data on failure. The board now keeps the last real payload and switches the dot to coral, drops the pulse, shows a coral hairline across the top of the stage, counts "server offline · 12m", and freezes the stamp at the last real reply. Before any successful poll it shows the markup's own `--` placeholders rather than anything at all.
- **`paintConnection()` owns every freshness signal.** One function sets dot, bar, errbar and stamp so they cannot disagree. The stamp reads `lastGoodAt`, never `new Date()` — that was half of why a dead board looked live.
- **Enter holds the draft when the save fails.** `commitDraft` used to close the composer before the POST and swallow the error, so a reminder typed at a dead server vanished with nothing saved and nothing said. It now keeps the text, cancels the 30s idle timer, marks the composer coral, and retries on the next Enter.

## The watchdog

`scripts\watchdog.ps1`, registered by `install-autostart.ps1` as **Home Board Watchdog**, probes `127.0.0.1:7879/api/data` every five minutes and restarts the task if it does not answer. Logs to `%LOCALAPPDATA%\home-board-watchdog.log`.

Task Scheduler's own restart-on-failure was already set on Home Board (`-RestartCount 3`) and did not save it: a process that exits has *completed* as far as the scheduler is concerned whatever the exit code, so the task just sat at Ready. A probe also catches a process still running but no longer answering, which restart-on-failure can never see.

Every task action launches via `conhost.exe --headless`. `powershell.exe -WindowStyle Hidden` alone is not enough on Windows 11: with Windows Terminal as the default console host the hidden style is ignored and each launch gets a real, focused tab — so the watchdog's five-minute repetition was popping a terminal over whatever was on screen twelve times an hour.

Two gotchas if you touch the registration. `[TimeSpan]::MaxValue` as `-RepetitionDuration` is rejected — it serialises to `P99999999DT23H59M59S`; leave `Duration` unset for "forever". And the task needs both an AtLogOn *and* a Once trigger: a repetition only starts when its trigger fires, so an AtLogOn-only watchdog registered mid-session stays dormant until the next logon.

### The morning restarts are not crashes (diagnosed 2026-10-18)

On a PC that is shut down overnight, every morning is a cold boot, and the watchdog restarts that showed up 1-3 minutes after one (System event 12) turned out not to be crashes at all. Three things stack up:

1. **A cold start takes ~56s.** Measured 2026-10-18: conhost 11:13:46 → powershell +6s → npm's cmd +22s → npm's node +49s → server +56s. Warm, it answers in 3s.
2. **The watchdog's Once trigger runs on a fixed five-minute grid**, set at registration, so on some mornings a tick lands inside that 56s window. It sees a starting board as hung and stops it. Mornings where no tick lands in the window log nothing.
3. **The stop-and-start doesn't work.** `Stop-ScheduledTask` leaves the node child running, and an immediate `Start-ScheduledTask` leaves the task at Ready with no board. Reproduced 2026-10-18 16:33: the board stayed dead until a second Start two minutes later. That second Start is the "restarted" line the AtLogOn run writes ~2 minutes after the first.

Across seven weeks of these restarts the board itself never crashed in a morning. What was actually unavailable was the PC, switched off overnight.

## Style

Follows a dark-tool-UI guide (Geist, tabular nums, negative tracking, white-alpha surfaces, 24px card radius, 6px rows, pill toggles). Three semantic colours only: green `--status-running`, amber `--status-stalled`, coral `--status-failed`. Never red.

The guide caps text at 14px for arm's-length reading. This is read across a room, so the scale is doubled: 28/26/24/22/20. Ratios preserved. `add.html` uses the guide's true 14px scale because it's a phone.

**Dark is the default.** `auto` still switches on sunrise/sunset from the weather feed and is one tap away, but it isn't the default: the toggle is a click handler, and if iCUE isn't delivering pointer events a board that goes light on its own with no way to override it is worse than one that stays dark. Dark is `#121212` shell, `#1c1c1c` card — grey, not black.

**The board is not a mobile page.** The 2560x720 stage scales to 0.152 on a 390px phone: 4px text, 12x7px theme buttons, well under the 44x44 minimum tap target. `add.html` is the phone surface and works properly there — tap-to-tick verified on both the checkbox and the row body. Don't debug the board on a phone; use `/add`.

## Verifying changes

There's no test suite. Layout was checked by rendering headlessly with Playwright at 2560x740 and asserting no column overflow and no text truncation, and the rain and geometry logic by importing the functions directly and running them against synthetic inputs. Worth continuing — the layout bugs in this project were all invisible in code review and obvious in a render.

## Ticketmaster: verified live (2026-08-02)

- **No capacity field on any venue.** Hardcoded per venue in `events.venues`; `minCapacity` is the only thing keeping 300-seat bars off the board. A 15km radius query returns ~45 events a fortnight, nearly all tiny — hence a curated venue list, not a radius.
- **Every event is listed twice**, once as itself and once as `Venue Premium - <name>` at an identical start. Deduped on venue + start time. Do NOT add the title to that key: the same show appears as "Hilary Duff - the lucky me tour" and "Hilary Duff: the lucky me tour" at one instant, and a title-aware key lets both through.
- **429s come back well under the documented 5 req/sec**, so venue calls are spaced 250ms apart.
- **Ibrox and Celtic Park return zero events** — stadium concerts there don't sell through Ticketmaster. Hampden does (`KovZ9177mPV`, listed as "Barclays Hampden").
- Timestamps are real UTC with a `Z`, unlike TheSportsDB. `dateTBD`/`timeTBA`/`noSpecificTime` are checked before trusting one.

## Still open

- Burn-in protection: slow pixel drift plus overnight dim, before it lives on a wall permanently.
- Cloudflare tunnel plus `apiToken` so reminders work off the home network.
- Frequency-ranked quick-add chips, once there's real usage data.
- Widget icon is a generated placeholder.
