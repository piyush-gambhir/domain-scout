# Domain Scout UX plan

Written October 7, 2026 after Piyush asked for a redesign of the first UI. The first UI was built from the functional spec, so its screens mirror backend modules (scans, jobs, catalogs, comparisons) instead of the tasks a person brings to the app. This plan starts from those tasks.

## Who uses the UI and why

Coding agents do most bulk work through the CLI. A person opens the UI to do one of these:

| Job | What the person wants to know | How often |
| --- | --- | --- |
| Name a thing | "I have a few words. Which domains are free, on which extensions, and what do they cost?" | Most visits |
| Triage a list | "My agent or brainstorm produced 50 to 1,000 candidates. Show me the unregistered, affordable ones so I can pick." | Common |
| Decide and buy | "I have a few favourites. Are they still free, what is the real cost over a few years, where do I buy?" | Every purchase |
| Wait for a name | "Tell me if this taken name frees up or a price drops." | Occasional |
| Set up | Add provider keys, preferences, clean data. | Rare |

The UI wins when the answer to the first question is on screen within seconds of typing, and when the path from "that one" to a purchase link is two clicks with fresh evidence.

## Problems in the first UI

1. Navigation lists nine system modules (Scan, Discover, Jobs, History, Shortlists, Compare, Monitor, Providers, Settings). Jobs and History overlap, Scan and Discover are two halves of one task, Compare is detached from the shortlist it should compare, and catalog refreshes appear as user jobs.
2. Searching is a form: an empty text area, a format dropdown, a label field, a cache toggle and budget fields, with no extensions selected by default and a disabled Run button.
3. Results are a raw table in input order. Taken and free names are interleaved, every row says "Stale" in orange, registered domains show a registration price that cannot be bought, and there is no Save or Buy on the row.
4. The domain panel leads with evidence internals (protocol, routing, HTTP status) instead of the decision (status, best price, where to buy).
5. Compare starts empty and asks the user to retype domains.
6. Monitoring, providers and settings are reasonable, but providers sit at the same level as daily tasks.

## Principles

1. Task-first navigation: four destinations a person thinks in (Search, Saved, Watching, History) plus Settings.
2. One input to start: typing a name and pressing Enter is enough; sensible defaults (remembered extension set) instead of required choices.
3. Results answer the question: group by what the user can do (register, buy secondhand, wait), sort free names by price, collapse what is taken.
4. Every row has its next action: Save, Buy (provider menu with prices), Watch, Details.
5. Honesty without noise: freshness shown quietly as "checked 3 min ago"; a recheck prompt appears only where it matters (saving, buying, comparing). Wording stays accurate: no "Available" claims (see Decision 3).
6. Evidence on demand: registry protocol, routing and raw responses stay one click away under "Registry details", not in the first view.
7. Fit the window: no page scroll at desktop sizes; only results and lists scroll in their pane (already in place).
8. Keyboard first: `/` focuses search, arrows move through results, `s` saves, `b` opens Buy, `w` watches, `Enter` opens details, `Esc` closes.

## New information architecture

| Destination | Replaces | Purpose |
| --- | --- | --- |
| Search (home) | Scan, Discover, job results | Type names, paste a list, drop a file, or ask for ideas; results stream in on the same page |
| Saved | Shortlists, Compare | Decision workspace: saved names with fresh status, cost over time by provider, quotes and Buy |
| Watching | Monitor | Watched names and an inbox of changes |
| History | Jobs, History | Recent searches (UI and agent/CLI runs) to reopen; system jobs hidden |
| Settings | Providers, Settings | Provider keys, preferences, coverage, data, service |

## Core journeys

1. **Name a thing.** Home shows one large input with the remembered extension set (default: com, io, dev, app, co, ai). Type "acme scout" and press Enter. Results appear as a grid: one row per name, one column per extension, each cell showing status and the lowest known first-year price. Click a free cell to open its panel: best price, three-year cost, Buy buttons per provider, Save.
2. **Triage a list.** Paste or drop 300 names. The same page switches to the list view: a summary strip (148 unregistered, 132 taken, 20 not checked), unregistered first sorted by price, filters for extension, max price and length. Select rows, Save to a list, or Watch.
3. **Decide and buy.** Saved shows the chosen names with a freshness banner ("3 names were checked over 15 minutes ago. Recheck"), a provider-by-provider cost table (first year, renewal, three years) and a Buy button for the cheapest complete offer. Requesting exact quotes is one button when keys exist; without keys it shows the published prices honestly labelled.
4. **Wait for a name.** From a taken name's row or panel, Watch. Watching lists watched names with their current state and an inbox of changes; the sidebar shows an unread count.
5. **Review agent work.** History shows CLI and UI searches together; opening one restores the Search results view. `domain-scout ui --job <id>` opens directly to it.

## Screen by screen

### Search (home and results)

- Header: the search input fills the width; extension set as removable chips with "+" to add and a preset menu; "Ideas" switch turns the input into keyword mode (generation) and shows suggestions as a selectable list with "Check selected".
- Advanced options live behind a small "Options" menu: input format, recheck instead of cache, label.
- Results, grid mode (up to about 30 names): rows are names, columns extensions; cells are status dots with short labels and price. Hovering a cell shows provider and freshness.
- Results, list mode (larger lists or by choice): grouped sections "Not registered", "Taken", "Not checked"; columns domain, status, lowest first-year price with provider, renewal, three-year cost, checked; row actions Save, Buy, Watch on hover and keyboard.
- Taken rows show expiry and aftermarket listings when known, never a registration price.
- Progress: a slim bar under the input while checks run; counts update live; cancel inline.
- Detail panel (docked): status and freshness first, then "Best prices" (provider, first year, renewal, three years, Buy), then Save and Watch, then collapsed "Registry details" (registrar, dates, nameservers, source, protocol) and "Checks" (name checks, DNS/TLS) when present.

### Saved

- Left: lists (default "Saved"), create and rename inline.
- Main: table of saved names with status, checked time, cheapest first year, renewal, three-year cost, notes; freshness banner with one-click recheck; "Compare providers" expands a row into a provider cost table (replaces the separate Compare page); "Get quotes" for configured providers; Buy.
- Export and snapshot from the list header.

### Watching

- Table of watched names: current state, last checked, next check, what changed last; inbox of notices with before and after values and links.
- Create from search results or Saved; editing interval and providers in a small dialog.

### History

- Recent searches from UI and agents with name count, extensions, results summary and time; reopen into Search; resume or retry incomplete ones. Catalog refreshes and watch runs are hidden by default.
- Price history moves into the domain panel ("Price over time") and Settings data views.

### Settings

- Tabs: Providers (keys, capabilities, catalogs), Preferences (default extensions, currency, horizon, theme), Checks (pacing, freshness), Coverage, Data, Service.

## Decisions (confirmed by Piyush, October 7, 2026)

1. Navigation: Search, Saved, Watching, History and Settings replace the nine module pages.
2. Results: a name-by-extension grid for small searches (up to about 30 names), a grouped list for larger lists, switchable either way.
3. Wording: a missing registry record reads "Not registered", with the tooltip "The registry has no record. Confirm with a provider before buying." "Available" is never used.
4. Default extension set for new searches: com, io, dev, app, co, ai (remembered and changeable).

## Supporting backend changes

- Prices for many suffixes at once (lowest first-year, renewal and three-year cost per provider) so result rows and the Buy menu need no per-row requests.
- Mark job origin (UI, CLI, watch, system) so History can show agent runs and hide system jobs.
- Default extension set stored in settings so CLI and UI share it.

## How we will know it works

- From opening the app to seeing which of five names are free on six extensions: one input and one Enter, under five seconds on cached data.
- From a free name to a provider checkout link: two clicks (row, Buy).
- No page scroll at 1440x900 and 1280x800 (already enforced by the layout spec).
- Every screen passes keyboard-only use, and Playwright covers the five journeys end to end.
