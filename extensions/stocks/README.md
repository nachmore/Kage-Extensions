# Stocks

**Online · Source: [Finnhub](https://finnhub.io/) · Data delayed when cached.**

Look up `$AAPL`, `stock msft`, or `stock aapl msft nvda`. Each quote shows
the symbol, company name when known, USD price, absolute and percentage
day change, direction in both text and color, source, and last-trade time.
Enter opens a public TradingView chart. Select the separate **Copy** action,
or enter `stock copy AAPL`, to copy text such as `AAPL 189.12 +1.3%`.
`stock` alone looks up the watchlist.

## Setup

1. Open Stocks settings and choose **Finnhub · US quotes · free personal key**.
2. Choose **Get a free key** to open https://finnhub.io/register in your
   system browser. Register and copy the API key from your dashboard.
3. Paste the key and choose **Test and save key**. The extension probes the
   AAPL quote endpoint and saves the key only after a valid quote response.
4. Edit the watchlist (up to 10 symbols) and refresh interval, then save
   regular settings.

No shared/demo credentials are shipped. Keys use the same
`save_extension_data` storage as Spotify credentials, separate from config.
That host storage is **not an encrypted vault**. The compatible setup text
input is visible while typing, but a saved key is never rendered back into
settings. The key is sent only to `https://finnhub.io/api/v1/quote`, using
the documented `token` query parameter because the live header-auth
preflight is not allowed. Requests omit cookies/referrers and reject
redirects. No request URLs, credentials, or raw provider errors are logged.
Remove the key in settings to stop authenticated requests.

Choose **Saved quotes only · offline** to suspend network requests while
retaining the last saved quotes and local history.

## Data and limits

Finnhub documents real-time US quotes, with a free limit of **60 calls per
minute** and a global **30 calls per second** ceiling. Stocks reserves at
most 40/minute and 20/second locally, uses a 300-second default refresh and a 60-second
minimum, deduplicates concurrent same-symbol requests inside a window,
and shares quote caches, request budgets and backoff across Kage windows.
Your other applications using the same key also consume Finnhub's limit.
Persistent storage has no atomic compare-and-swap, so cross-window budget
coordination is best effort, as in Spotify. A 429 response applies shared
exponential backoff and respects `Retry-After` when the browser exposes it.
Offline, server and authentication failures also back off. Cached values
keep their original last-trade and retrieval timestamps.

The floating-window widget uses the same cache. Current Kage hosts skip
widget polls while hidden; the extension also honors document visibility.
Closed markets retain the last reported trade; values older than 15 minutes
say **Data delayed / market may be closed**. This is a freshness label, not
an exchange calendar or a guarantee of market state.

US symbols and share classes such as `BRK.B` are accepted; `AAPL.US` is an
alias for `AAPL`. International suffixes such as `.L`, `.TO` and `.JP`
produce an explanation instead of being silently stripped or mapped to a
different US stock. Unknown symbols never turn into zero-price quotes.

### Sparklines and agent tools

The optional sparkline uses **locally sampled quotes**, collecting actual
provider timestamps as the extension is used. It does not make additional
requests, fill gaps, or imply a complete trading-day series. The cache
retains at most 512 samples per queried symbol for up to 31 days.

- `get_quote(symbols)` returns quotes, source, currency, trade timestamps,
  fetch times, cache status, and per-symbol errors.
- `get_history(symbol, range)` returns local samples for `1d`, `1w`, or
  `1m`, explicitly marked `kind: locally_sampled_quotes` and
  `complete: false`. It performs no network requests. It can be empty.

Finnhub's `/stock/candle` endpoint requires premium access. Stocks never
calls it or describes local observations as historical candles.

### Provider terms

[Finnhub terms](https://finnhub.io/terms-of-service) restrict personal plans
to eligible personal, non-business use and prohibit sharing data or derived
results with third parties without written approval. These restrictions
also matter for copied data and externally hosted AI agents. Distribution
of this open-source extension does not grant redistribution rights for
market data. Every displayed quote identifies Finnhub; no separate
mandatory attribution format was found in the terms inspected.

## Why a key is required

The requested no-setup delayed source was checked on **2026-11-06**, before
choosing a provider. This release uses the authorized guided-key fallback:

| Candidate | Live curl findings | Decision |
| --- | --- | --- |
| Stooq | `https://stooq.com/q/l/?s=aapl.us&f=sd2t2ohlcv&h&e=csv` returned **404**, as did `.pl` and non-US/unknown-symbol variants. `https://stooq.com/q/d/l/?s=aapl.us&i=d` returned **200 HTML with a JavaScript proof-of-work browser challenge**, not CSV. | No challenge bypass or scraping. No functioning keyless quote endpoint was verified. Its `https://stooq.com/t/` terms page was also challenged, so current usage rights, attribution, and a free request limit could not be verified. The commonly cited “15-minute delay” is not treated as a current guarantee. |
| Finnhub | Quote/candle requests without a key returned **401 “Please use an API key.”** An intentionally invalid key returned **401 “Invalid API key”**, including header authentication. Null-origin OPTIONS returned **200** but omitted `Access-Control-Allow-Headers`, so custom-token-header authentication cannot be used by browser fetch. | BYO free key, simple CORS GET. No valid personal key was available for a successful authenticated live probe; parser and workflows are tested with mocked documented responses. |
| Twelve Data | `quote` and five daily `time_series` points for AAPL with the public documentation `demo` credential returned **200 JSON**. Missing/invalid credentials returned **401**. | Excluded. Current [pricing](https://twelvedata.com/pricing) lists Basic **8 API credits/minute, 800/day**, but explicitly limits it to testing/evaluation/development and forbids user display or production. Do not infer production rights from a working demo. |

Primary sources inspected:

- https://finnhub.io/pricing — current free 60/minute table, rendered from
  its public page's JavaScript bundle.
- https://finnhub.io/docs/api/rate-limit — HTTP 429 and 30/second ceiling.
- https://finnhub.io/docs/api/quote — real-time US quotes; constant polling
  discouraged; international live quotes require Enterprise access.
- https://finnhub.io/docs/api/stock-candles — premium candle endpoint.
- https://finnhub.io/terms-of-service — personal-use and redistribution terms.
- https://twelvedata.com/pricing — Basic limits and production/display restriction.
- https://twelvedata.com/terms — internal use and external-display license requirements.
- https://support.twelvedata.com/en/articles/12647398-attribution-guidelines-for-using-twelve-data
  — external display requires visible “Data provided by Twelve Data” with
  a dofollow provider link unless contracted otherwise; private/internal
  use is exempt, subject to market-specific rules.

Some Twelve Data support pages still describe the older free plan as
including live US quotes. The current pricing restriction is the reason
that provider is not implemented here.

## Host compatibility

The existing host supports search, widgets, settings, and tools. No host
changes are needed to run this release. Only `storage` and `urls`
capabilities are requested. Kage currently has **no manifest field for
exact-domain fetch permissions**; its `network` capability covers Rust
metadata commands, not sandbox `fetch`. The only fetch destination is
enforced in extension code: `finnhub.io`. Browser navigation is limited to
the Finnhub setup/source links and `www.tradingview.com` charts.

Potential host improvements, not implemented in Kage: exact-origin fetch
grants, atomic extension-data transactions, password/masked scratch
controls, and handling `copy` effects returned by `onResultAction` so a
quote row can have an inline clipboard button.

## Development

All tests stub `fetch`; they never request live market data. Run:

```sh
npx vitest run extensions/stocks
npm run check:all
npm test
```

English is canonical. The other 31 locales use Kage's existing
`scripts/translate.py` Claude-CLI workflow, scoped to this extension's
catalog through its task-building functions. Machine translations retain
the workflow's source hashes and flags; human review is welcome.
