# Issue #85: Kindle price tracking feasibility and handoff

Investigated 2026-09-11 against main `289ca08` and
[issue #85](https://github.com/ccmalcom/shelfsprite/issues/85).

## Outcome

Implementation remains blocked. Chase confirmed that no Creators API or alternate pricing
source is available and would consider setting one up if free. No application code, migrations,
scheduled jobs, or notification settings were added. This investigation does not close #85.

## Evidence and corrections

- Amazon Associates enrollment is free, but the
  [Creators API prerequisites](https://affiliate-program.amazon.com/creatorsapi/docs/en-us/introduction)
  still require at least 10 qualifying sales in the preceding 30 days. Account creation alone
  does not establish API access. No authenticated API request was possible during this investigation.
- **Access is not the only prerequisite.** Amazon's
  [Participation Requirements §6(y)](https://affiliate-program.amazon.com/help/operating/policies)
  prohibit price tracking and alerting unless Amazon agrees otherwise. The same page's IP License
  §2(h) limits ordinary non-image content caching to 24 hours before refresh. Historical price
  retention needs an explicitly supported arrangement; obtaining credentials alone is insufficient.
  This adds a blocker missing from #85's original recommendation.
- [eReaderIQ's FAQ](https://www.ereaderiq.com/faq) offers free Kindle tracking to readers with an
  account and describes email notifications. No documented integration API was found in the public
  pages reviewed. A link to its website is a possible smaller product change, but would not make
  ShelfSprite a price tracker or automatically synchronize a to-read shelf.
- [Keepa's API](https://keepa.com/api-docs/) requires a subscription. Its documentation describes
  history, search, and tracking endpoints; this investigation did not establish usable Kindle price
  coverage, a free API plan, or suitable redistribution rights. It is an unverified candidate,
  not an integration selected for implementation.
- The repository already has scheduling infrastructure: `vercel.json` registers a daily
  `/api/enrich/janitor` cron. [Hosting documentation](hosting.md#vercel-cron-and-enrichment-continuation)
  explains its production-only execution. There is no price-polling workflow, stored Kindle ASIN
  mapping, or price-alert delivery channel. The existing enrichment loop cannot simply be reused:
  its eligibility excludes unrated to-read books.

## Resumption plan

Respect the issue's instruction to settle sourcing before designing the feature. Resume only
with an accessible source whose supported use includes the intended history and alerts.

1. Prove live Kindle prices for representative to-read books, including ambiguous editions and
   unavailable offers. Establish marketplace, currency, freshness, retention, quotas, and cost.
2. Spike catalog-book to Kindle-edition resolution. Do not treat a print ISBN or the existing
   Amazon search link as a Kindle ASIN. Surface ambiguous matches for user confirmation.
3. With those results, write the implementation plan: tenant-scoped watches, permitted history,
   bounded scheduled polling, price-drop semantics, and an opt-in notification channel.
   Include retries, duplicate-alert prevention, stale/unavailable prices, pruning, and account deletion.
4. Implement and review against that plan. Run both test runners, type checking, lint, formatting,
   and the Next build. Exercise watch creation through actual provider polling and alert delivery,
   including a second user's isolation and disabled/revoked provider access.

## Next-session prompt

> Continue ShelfSprite issue #85 from this handoff. First establish whether a usable pricing source
> and the required tracking/history permissions now exist. Revalidate the dated evidence. If they
> do, prove real Kindle offers and edition matching before planning and implementing the tracker.
> Do not substitute mocked prices, an external link, or dormant infrastructure for the requested
> feature. Preserve the issue as open until its user-visible acceptance flow is verified.

## Verification

Reviewed the issue and its linked #83 discussion, the cited provider pages, catalog links, schema,
and scheduling documentation/configuration. This is a documentation-only result. Application tests,
build, and browser verification were not run; no tracker was implemented or exercised.
