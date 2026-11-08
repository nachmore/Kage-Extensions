# Stocks

**Online · No keys needed · [Stocklake](https://stocklake.dev/) quotes delayed
about 15 minutes · about 25 symbol lookups a day without a key, or 200 with a free key.**
[Finnhub](https://finnhub.io/) is optional for live US quotes with your own
free key (60 calls/minute).

Type `$AAPL`, `stock msft`, or `stock aapl msft nvda`. Quotes show the symbol,
company, currency, price, day change, provider, and **Updated** time for Stocklake (its refresh time), or **As of** for Finnhub. Enter opens
a public TradingView chart. Choose the separate **Copy** action, or type
`stock copy AAPL`, to copy invariant text such as `AAPL 189.12 +1.3%`.
Bare `stock` asks guests to type a symbol without fetching; keyed users see their watchlist. Search leaves prose with the agent, waits for a 1.3-second guest typing pause (600 ms with a key) on cache misses, and checks for a newer query before every network step.
There is no persistent setup hint. `$AAPL` works immediately on Stocklake.

## Providers and migration

Stocklake is the default for new installations and existing installations
without a Finnhub key. An existing Finnhub key keeps Finnhub, regardless of
retired `provider` values (`cache`, missing, or otherwise).
An explicitly selected provider takes precedence thereafter while its required key is saved. Removing the last Finnhub key falls back to Stocklake, including records saved by 1.1.0.
Stocklake maps share classes such as `BRK.B` to `BRK-B` on the wire, keeping your spelling in results. Exchange suffixes are preserved. It accepts US and international tickers such as `SAP.DE`, `VOD.L`,
`NOVO-B.CO`, and `7203.T`. Finnhub retains its US-only suffix restriction;
`AAPL.US` remains an alias for `AAPL`. Queries/watchlists accept up to ten
unique symbols. Unknown symbols never become zero-price quotes.

In Stocks settings, choose **Stocklake** or **Finnhub**. Each choice has a
short explanation, a key field, and **Test and use provider**. That button
saves the provider choice and saves a supplied key only after a valid AAPL
quote test. A Stocklake key is optional; its free sign-in uses an emailed code.
Leave the field empty to test a saved key, or select guest Stocklake when none is saved. A keyed test consumes one lookup; selecting guest Stocklake skips the test and consumes nothing. Regular Save updates watchlist/display/tool settings;
**Test and use provider** applies the provider selection on both old and new hosts. Save explains this if you changed the selection, and validates against the active provider. Keys for both providers are retained when switching. Each provider has its own saved-key status and **Remove saved key** action. Removing a key preserves the active provider, except removing the active Finnhub key explicitly switches to Stocklake guest and says so.

## Budget and caching

Stocklake refreshes prices about every ten minutes on trading days and is
about fifteen minutes behind the market. Every Stocklake quote says
**Delayed ~15 min · Stocklake · EUR · Updated 10:41 PM** (with the quote's own currency and local time). Search rows have plain-text credit so clicking the credit cannot also open a chart. Its timestamp is the
provider's `updated_at` snapshot time, not a newly invented last-trade time.

- Quotes are cached for **at least ten minutes**, even if the refresh setting
  is shorter. A longer configured interval is respected.
- All uncached lookups use `get_stocks`, reserving **one lookup per
  symbol**; batching does not turn ten symbols into one billed lookup.
- Unknown tickers are negatively cached for ten minutes and never pause other lookups.
- Offline and superseded queries are checked before reserving; unsent network failures refund their reservation. A paid response is kept even if header/budget synchronization fails.
- Guest requests reserve a durable local **25/day** budget before fetching.
  A key starts at **200/day**. The separate guest count survives key additions,
  removals and provider switches; switching keys never replenishes a count.
- Readable `x-ratelimit-limit`, `x-ratelimit-remaining`, and
  `x-ratelimit-reset` headers synchronize that budget conservatively. Counts
  never increase mid-day from a late response. Reset epochs are clamped to at most 24 hours ahead;
  otherwise the reset is **midnight UTC**.
- The live API currently does not expose those headers through
  `Access-Control-Expose-Headers`. A browser therefore retains its conservative
  local count when headers cannot be read. Other apps sharing the IP/key can
  exhaust the service first; guest HTTP 401 and HTTP 429 close the local budget
  until reset, with no retry. There is no proxy or sharing between users.
- On exhaustion, saved quotes keep their original **Updated** time and say:
  **Daily free quotes used up. Resets at &lt;local time&gt;. Add a free Stocklake key
  for 200 a day.** Reset times are short, such as **7:00 PM** or **Mon 9:00 AM**. Enter on an exhausted row opens settings. The same reset message appears for an uncached symbol.
- The watchlist panel **requires a key** as well as its visibility setting.
  Guest installations never poll or display a setup nag, including old configs
  with the panel enabled. This saves the small guest allowance for deliberate
  searches. Keyed Stocklake polling still uses the ten-minute cache and hard
  daily budget. Current hosts and the extension pause hidden-window polling.

Finnhub keeps its 300-second default refresh, 60-second minimum, local ceilings
of 40 requests/minute and 20/second, negative caching, shared exponential
backoff, and 2.2-second request timeout. Stocklake also uses that timeout and
short pauses after transport/authentication failures. No provider request is
retried to avoid a limit. Candidate-key tests respect budgets and do not poison
the saved key's authentication state.

Caches, budgets and nonce-checked storage leases coordinate only this user's
Kage windows. The host offers no atomic compare-and-swap, so coordination is
best effort. Budget I/O failures fail closed before any network request. A torn
Stocklake budget stays closed until midnight rather than granting another
allowance; the message includes the end time. Cached quotes remain usable when offline or limited. Finnhub quotes older than fifteen minutes indicate possible delay/closed markets; Stocklake shows its delay label once. Saved quotes are retained for up to 31 days.

## History, sparklines and agent tools

Stocklake sparklines use **real daily closing prices**, obtained from
`get_stock_history(symbol, days: 30)` and cached for **one day**. Guests only show already saved history; a cold search costs one lookup per symbol and never fetches history automatically. Keyed search returns quote rows first and fetches history in parallel afterward, checking for newer queries before each request. The host has no search push-update API, so newly fetched history is available on subsequent renders. History failure never hides a valid quote. There are no AI research or news
requests. Guest/free history supports up to 365 trading days, but this extension
requests only about 30. The same cached window serves the tools' `1d` (latest
bar), `1w` (latest five bars), and `1m` (latest thirty bars) ranges.

Finnhub sparklines and history continue to use actual locally observed quotes,
with gaps, capped at 512 samples over 31 days. Finnhub's premium candle endpoint
is never called. Provider changes do not relabel another provider's quote cache.
**Delete saved quotes** also deletes tracked daily-history caches, retaining
both keys, the provider selection, and rate budgets. Maintenance prunes up to
20 tracked symbols per daily pass; the `qidx` index retains its old-index migration
and `INDEX` ticker collision protection. Other windows can save records again.

Agent tools are **off by default**. Enable **Allow Stocks tools for agents**
and restart Kage if provider terms allow your use with your agent provider.

- `get_quote(symbols)` returns prices, currency, source, exchange/volume where
  provided, cache status, ISO snapshot/fetch/retry times, and per-symbol messages.
  Malformed symbols do not prevent valid siblings from succeeding.
- `get_history(symbol, range = "1m")` returns Stocklake `kind: daily_history` with real
  daily OHLCV and close prices on demand (one daily lookup on a cache miss, including for guests), or Finnhub `kind: locally_sampled_quotes` with
  `complete: false`. Stocklake failures/exhaustion can return saved daily history.

## Credentials, transport and terms

No shared or demo credentials are shipped. Both keys and provider selection use
`save_extension_data` under **credentials**, separately from regular config,
covered by `sensitiveData: ["credentials"]`. Host storage is **not an encrypted
vault**. The compatible text input is visible while typing; saved keys are never
rendered back. Normalization keeps keys out of regular config and blanks credential scratch fields on older hosts. Tests assert keys cannot appear in schemas or results.

Stocklake uses stateless HTTP JSON-RPC POST to **https://api.stocklake.dev/mcp**,
with `Content-Type: application/json` and
`Accept: application/json, text/event-stream`; no session header is required.
An optional key uses documented `Authorization: Bearer`. CORS permits anonymous
sandbox fetches. Finnhub uses its documented `token` query parameter only on
**https://finnhub.io/api/v1/quote**, because its live header-auth preflight is
not supported. Fetches omit cookies/referrers and reject redirects. Destinations
are fixed constants in code, never supplied by config or data. Neither request
URLs, secrets nor raw provider errors are logged or returned.

[Stocklake legal](https://stocklake.dev/legal) permits normal personal/internal
client use and forbids reselling, redistributing or sublicensing data/access,
circumventing limits, and building downstream feeds/mirrors. Each user's own Kage
calls the API for that user's own use. The extension does not grant redistribution
rights. [Finnhub terms](https://finnhub.io/terms-of-service) also restrict
personal plans and third-party sharing; check your agreement before sending
results to external agents or using them for business.

Product, [getting-started docs](https://stocklake.dev/docs),
[tool reference](https://stocklake.dev/docs/tools), and legal were re-read on
**2026-11-08**. The captured live guest responses verified the `price` field, JSON-in-MCP-text
response shape, real daily history, CORS, and daily rate headers. Trimmed response
fixtures preserve those wire shapes, including the supplied batch response and headers. No new live Stocklake calls were made for 1.1.1. All development tests mock network calls.

## Host compatibility and development

Only `storage` and `urls` permissions are requested. This host has **no manifest
field for exact-domain fetch permissions**; both API origins are declared and
enforced in `client.js`, the same way Finnhub was previously declared. Navigation
uses provider links and public TradingView charts. No host/repo changes are needed.
The scratch provider selector avoids manifest-default overlays breaking key
migration; Test/use saves it in extension data. Generic Save never saves keys.
Provider transport stays in `client.js` and its shared dependencies remain leaves
for the host's single-pass module rewriting; host-loader tests exercise all four
providers. Display numbers/reset times use local language/timezone; clipboard and
tool timestamps remain invariant.

```sh
npx vitest run extensions/stocks
npm run check:all
npm test
```

English is canonical. All other 31 catalogs use Kage's existing
`scripts/translate.py` Claude-CLI workflow, scoped to this extension through its
task-building functions. Source hashes and machine-translation flags are retained.
