# Tile audit

Every tile has to answer a question someone actually asks and change something they do. "Logged" metrics come from `npm run report`. "Diary" means a one-line phone note each time the board changes a decision, kept for two weeks.

Set `capture.until` in `config.json` to two weeks out, keep the diary until then, and review the table on that date.

| Tile | Question it answers | Decision it changes | Keep if |
|---|---|---|---|
| **Clock and date** | What time is it? | When to leave | Always keep: it's the anchor people glance at first |
| **Now: temp, sky, high/low** | What's it like out? | What to wear | Diary: at least 1 clothing decision a week |
| **Feels like / wind / gusting / rain today** | Is it worse than the number says? | Coat vs jacket, cycling | Diary: cited separately from the big temperature at least once in 14 days. Otherwise fold it into one line |
| **Rain sentence** | Will I get wet, and when? | Umbrella; leave now or wait | Logged: onsets warned ≥80%, false "rain from" ≤20% |
| **Hourly strip (8h)** | How does the afternoon go? | Plans later today | Diary: used for something the rain sentence didn't already say |
| **Departures (3 routes)** | How long to get there right now? | Leave earlier or later, pick a route | Diary: at least 1 changed departure a week. Logged: the route isn't "clear" every single time. A row that's always "on time" carries no information |
| **Trend arrow** | Getting better or worse? | Wait 10 minutes or go now | Diary: at least 1 "waited because it was clearing". Note it's blank for the first 20 minutes after a boot |
| **Match / event banners + chips** | Is something going to clog my route? | Avoid town, leave early | Logged: delay on flagged slots ≥2 min above the same weekday and hour unflagged |
| **Reminders** | What do we need to do? | Get it done | Logged: ≥70% done within 7 days, median open age <7 days, ≥25% added by the second person |
| **Claude Code usage** (optional) | Can I keep working at this pace? | Pace work, switch model | Diary: at least 1 pacing decision a week |
| **Footer: sunrise/sunset, theme, updated stamp** | Is this live? When does it get dark? | Trust the board or not | Keep the connection signals regardless: they're what stops a dead board looking live |

## Reading the results

- A tile that fails its bar for two weeks running is a candidate to cut or merge, not to redesign.
- Overlapping tiles (the three weather blocks all answer roughly "what's it like") are settled by the diary: keep the one people actually cite.
- If the report says the board is down in the mornings, check whether the PC was simply switched off before blaming the code.
