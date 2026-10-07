# Growing-family performance

Measured on 2026-10-07. Long mood histories caused visible stalls well before the existing storage quota. Fixed-size history pages now keep at most 30 mood cards mounted. Filtering and totals still use the complete visible history; changing pages or filters preserves the entry draft and any record being edited.

## Fixtures and method

All records were fictional. A separate local HTTP server served copied production builds and synthetic, gzip-compressed bootstrap responses. It rejected writes. Existing D1 data, app sessions, and browser storage were untouched.

| Fixture | Recipes | Daily history | Habit logs | Total records | Serialized record-data bytes | Full bootstrap bytes |
| --- | ---: | --- | --- | ---: | ---: | ---: |
| Two years | 500 | 730 moods and 730 answers per person, two people | Four habits × 730 days | 6,616 | 2,377,785 | 3,427,861 |
| Five years | 500 | 1,825 moods and 1,825 answers per person, two people | One habit × 1,825 days | 9,898 | 3,115,610 | 4,690,167 |

Each fixture also contained two profiles, 100 tasks, 100 notes, 50 events, and 20 goals. Recipes had 12 ingredients and eight steps. All fixture moods were shared deliberately, allowing the shared-history view to exercise the largest permitted visible collection. The personal-history view still displayed only the current member’s entries.

Both fixtures fit the enforced **10,000-record / 8,388,608-byte** quota. The byte quota counts serialized `record.data`, excluding metadata and the bootstrap envelope; private and disabled-module records still consume quota. Five years of two people recording a mood, answer, and their own habit every day, plus 500 recipes, would exceed the record quota. The five-year fixture therefore used one daily household habit.

Measurements used Chromium **151.0.7922.173**, a **390 × 844 CSS-pixel** mobile viewport, device scale factor 1, touch/mobile emulation, and CDP **4× CPU throttling**. Each build/fixture combination ran three times in a fresh browser context, with service workers blocked. The 30-second refresh interval was suppressed during this comparison to isolate rendering; every run made exactly one bootstrap request.

Navigation/filter timings run from the action until the second animation frame after the resulting view appears, including automation overhead. Typing timings run from the captured DOM `input` event to the second animation frame, with three input events per run. These are laboratory measurements, not field INP or LCP metrics.

The baseline was the production bundle from checkpoint `1d0bc1a`, SHA-256 `0b3f288a9e795277fffb23a9ed06f63731b19aea170207454d6ccd6d62c4c7a9`. The comparison bundle containing mood pagination and memoization was `4ab320c063529694de6c2de79ca3e835f92292cd5ee3baeb2a31684cf6c175e4`.

## Mood results

Times are medians. Navigation/filter rows contain three measurements per cell; typing contains nine.

| Action | Two years, before | Two years, after | Five years, before | Five years, after |
| --- | ---: | ---: | ---: | ---: |
| Open mood history from Today | 3,186 ms | 363 ms | 7,150 ms | 502 ms |
| Type in the entry note, input → frames | 1,051 ms | 24 ms | 2,971 ms | 42 ms |
| Switch to shared history | 4,409 ms | 195 ms | 18,357 ms | 192 ms |
| Open the next shared-history page | — | 229 ms | — | 239 ms |

The five-year after measurements ranged from 354–661 ms when opening moods, 18–76 ms for the input event, and 189–612 ms when switching filters. No typing action in either after fixture produced a main-thread long task of 50 ms or more. Concurrent activity on the shared execution host contributed to timing variation; the mounted-card bound is deterministic.

| View | Before cards / document elements | After cards / document elements |
| --- | ---: | ---: |
| Two-year personal history | 730 / 17,059 | 30 / 977 |
| Two-year shared history | 1,460 / 23,629 | 30 / 767 |
| Five-year personal history | 1,825 / 42,244 | 30 / 977 |
| Five-year shared history | 3,650 / 58,669 | 30 / 767 |

The implementation memoizes the complete mood filter/sort against the family-record snapshot and formats dates only for the selected page. Previous/next controls appear above and below the list. Filter changes reset to page one; deletions or refreshed counts clamp an out-of-range page. Bottom controls return focus to the history heading.

Four dedicated browser tests cover five-year bounds and ordering, draft retention across pages/filters, editing an off-page record, deletion of the last item on a page, mobile focus and layout, and WCAG A/AA checks. The existing private/share/reverse mood flow also passed. Page-number metadata remains 12 px at 320 px width without horizontal overflow.

```sh
npx playwright test tests/e2e/mood-pagination.spec.ts
npx playwright test tests/e2e/wellness.spec.ts -g 'moods are private'
```

## Other observations and limits

An initial single-run survey of the same five-year fixture mounted all **500 recipe cards / 12,254 document elements**. At 4× CPU, opening that collection took **1,636 ms** and clearing its search took **1,546 ms**. Those measurements established the case for bounded recipe pages; they are baseline observations, not verification of later recipe changes.

Question history initially rendered 20 cards, habit calendars at most 42 date cells, and profiles at most 32 distinct current-catalog preferences. Their initial survey interactions were much smaller than the unbounded mood history. This does not establish performance for expanding every historical question or for additional future question catalogs.

The Today dashboard remained bounded to 531 document elements. Its complete cold-load timings across the controlled before/after runs ranged from **796–1,707 ms**; this work makes no cold-start improvement claim.

No real mobile hardware, network latency, Cloudflare edge execution, D1 query latency, or AI inference was measured. Repeated fictional text compresses unusually well, so the gzip transfer sizes are not a production bandwidth estimate. Client pagination does not reduce the complete bootstrap payload or the server’s full-snapshot query. The current quota remains necessary; server pagination, archival, and refresh payload reduction should be evaluated before increasing it.
