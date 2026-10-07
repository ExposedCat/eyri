# Stock Manager for Telegram

## Stack

- Interactive Brokers Gateway API
- gnzsnz/ib-gateway
- TypeScript
- grammY
- SQLite

## Integrations

Use `/integrations` to manage accounts in a rich message. Each account has an
inline red Delete button. Choose **Add integration**, select **Freedom24**,
**IBKR** or **Trading 212**, and send the requested credentials. `/cancel` cancels
credential entry.
The selected provider is saved per user and chat, including across bot restarts.

Use `/ibkr [instance_url] [flex_token] [flex_query_id]` in Telegram to persist
an Interactive Brokers integration for the current user.

Use `/f24 [api_key] [secret_key] [history_years]` to persist a Freedom24
integration. `history_years` is optional and defaults to 10.

Use `/t212 [api_key] [secret_key]` to persist a read-only Trading 212
integration. It always uses the live API. Generate a key and secret in your live
account under Settings → API (Beta), with
Portfolio, History - Orders and History - Transactions read permissions, and leave trading permissions off.
Invest and Stocks & Shares ISA accounts are supported.

Trading 212 holdings and executed trades are stored in instrument currency;
reports convert money to USD using the latest Frankfurter rates. Reported returns
exclude historical FX effects and wallet fees/taxes.
US equity IDs such as `AAPL_US_EQ` display as `AAPL`; other listing IDs are preserved.
Order history is cached in SQLite and paginated, then refreshed incrementally at
most once per minute. A large first import can take time because of API rate limits.
Unsupported corporate actions cause history-based calculations to report an error
rather than produce misleading FIFO results. Portfolio views without bucket
allocations use live holdings and do not require a history import.
Daily P&L is unavailable because the API provides no previous-close baseline.

Trading 212 cash history is imported automatically with order history; enable
read-only **History - Transactions** permission as well. Internal transfer
returns appear as a regular CFD purchase row in `/history`, included in its
chronological year sections, totals and bucket shortcuts. Sending $100 to CFD
and returning $500 produces `CFD 1.0000 x $400.00 ($400)`. The amount is the net
cash returned, converted to USD at current rates. Transfers are treated as CFD
cash movements; the API does not identify the other account. These history rows
do not create live holdings or stock FIFO lots.

All commands display money and combined totals in USD. GBX is treated as pence
(100 GBX = 1 GBP) before USD conversion. Long portfolio and bucket messages continue across
Telegram messages without changing transaction shortcut numbers.
The published API terms require Trading 212's written consent for applications
intended for other end-users; this integration is for personal account tracking.

These commands keep their existing formats; each successful submission adds a
new account. Users can connect multiple accounts from the same provider. Use
`/integration_delete NUMBER` or the account's Delete button to remove one account.
Numbers are positions in your `/integrations` list, starting at 1.
The old `/integration_delete ibkr` or `/integration_delete f24` shortcut works
only when the user has exactly one account of that provider.

Portfolio, stocks, options, performance, daily P&L and history fetch each saved
account independently. Matching holdings are combined internally by ticker and currency,
with summed values and weighted prices; sold gains are calculated separately
for each account before aggregation. Provider-specific daily P&L baselines are
preserved. If any account fails, the command identifies it instead of displaying
an incomplete total. Existing accounts and cached broker history are preserved
by an automatic database migration on startup.

`/stocks`, `/options`, `/perf`, `/sold`, `/alltime`, `/dpnl`, `/history`,
`/when`, bucket views and diagnostic dumps display USD amounts using the latest
Frankfurter rates. Prices supplied to `/when` are USD. History prices and realized
gains use the same current FX rates as holdings; FIFO matching and bucket shortcuts
retain their original transaction identity. A required FX failure reports an error
instead of displaying a partial total.

Rich integration controls use Telegram Bot API 10.3's `sendRichMessage`, inline
`RichTextButton` and `InputRichBlockButtons`. A small typed raw API wrapper
allows these methods to work with the currently installed grammY version.

Freedom24 holdings and book cost come from the live portfolio, preserving ticker
changes and stock splits. Daily P&L uses the broker's previous-day portfolio P&L;
instruments with no trade today show zero, as in Freedom24. The total daily
percentage uses current portfolio value, matching the app's summary. Historical
orders supply holding dates when their tickers still match.

## All-time performance

Use `/alltime` (or `/alltime BUCKET`) to combine `/perf` and `/sold` into one
line per ticker and a single Total. Gains include current holdings and realized
FIFO gains from available order history. Percentages use their combined cost
basis. Sold lots follow the bucket of their purchase transaction; unbucketed
views exclude bucketed lots. Periods run from the earliest purchase to today for
current holdings, or the final sale for fully sold holdings.

## Portfolio chart

Use `/portfolio` (or `/portfolio BUCKET`) to chart stock allocation, largest first.
Bars show each holding's share of stock market value, with losing holdings below
zero. Below each ticker are its percentage return and monetary gain or loss.
All holdings are combined into one USD chart using the latest Frankfurter exchange
rates for values, purchase costs, and monetary returns. GBX is converted as pence
(100 GBX = 1 GBP) using the USD/GBP rate. Matching tickers are merged after conversion;
allocation weights and the header total are calculated in USD. Large portfolios
use one wider image, sent as an original PNG file to preserve sharp text when zooming.
If a required exchange rate is unavailable, the command reports an error.
The container includes Python and Matplotlib for rendering; local runs need
`python3` with `matplotlib==3.11.2` installed.

## All-time chart

Use `/chart` (or `/chart BUCKET`) for a daily time series of current plus realized
performance. The percentage is gain divided by the cost of open holdings plus
FIFO-matched sold lots, as in `/alltime`. The graph starts at the first purchase;
sales retain their realized gains, weekends carry the last close, and stock splits
adjust historical quantities and unit costs. Today's endpoint uses broker prices
and book cost. All amounts use the latest USD exchange rates consistently across
the series, excluding historical FX effects, dividends and fees.

The chart is sent as a Telegram photo using the portfolio's dark background,
mint gains and pink losses. Every month has a label and a vertical grid line;
the plot and participant legend fill the image, with no header or footer.
**Compare** adds the person clicking the button to that same graph, up to six
participants. Published curves remain snapshots of what their owners shared;
the button fetches only the clicker's own accounts. Buttons are bound to their
chat and message, survive restarts, and reject duplicate participants.

Historical data is stored in the existing SQLite database. Finalized daily closes,
split events, symbol resolutions and fetched date ranges persist without expiry.
Only missing historical ranges are downloaded; weekends and holidays count as
covered. Today and the preceding two UTC days remain provisional and are cached
for five minutes.
Yahoo's split-adjusted closes are converted to stable raw closes using split
events, so later splits do not require downloading the old prices again. Computed
series and PNGs also persist, with the most recent 128 of each retained.

Built-in patterns resolve Trading 212 symbols even when exchange metadata or an
ISIN is absent. Patterns are scoped to the instrument currency:

| Broker ticker pattern | Currency | Yahoo candidates, in order |
| --- | --- | --- |
| Freedom24 `*.US` | USD | Remove `.US` (e.g. `CRDO.US` → `CRDO`) |
| `*_US_EQ` | USD | US symbol (e.g. `AAPL_US_EQ` → `AAPL`) |
| `*d_EQ` | EUR | `.DE`, then `.F` |
| `*p_EQ` | EUR | `.PA` |
| `*l_EQ` | GBP / GBX | `.L` |
| `*l_EQ` | USD | `.IL`, then `.L` |
| IBKR bare symbol | USD | Same symbol (`BRK B` / `BRK.B` → `BRK-B`) |
| Bare symbol | GBP / GBX | `.L`, then the original symbol |
| `VUAA`, `SPYL` | USD | `VUAA.L`, `SPYL.L` |

Existing Yahoo exchange suffixes remain intact. When normal candidates and ISIN
lookup fail, the resolver tries up to six likely exchange variants based on the
broker currency. USD symbols try `.L` and `.IL`; EUR symbols try `.DE`, `.F`,
`.PA`, `.AS`, `.MI` and `.MC`. Other supported currencies have their local Yahoo
suffixes (for example CAD `.TO` / `.V` and HKD `.HK`). Broker suffixes are stripped
before these attempts, and numeric Hong Kong symbols are padded to four digits.
Candidates must match the quote currency (GBP and GBX are interchangeable) and
cover the first purchase. Successful resolutions persist for future commands;
failed ISIN search does not prevent trying the chart candidates. Explicit
`/yahoo` mappings stay authoritative and are never silently replaced by guesses.
Patterns also accept the normalized uppercase broker tickers. Exchange hints and
ISIN search provide additional candidates. Resolution checks that
the selected listing covers the first purchase (for example, Samsung's full London
history is `SMSN.IL`, while `SMSN.L` only begins in July 2026).

Use `/yahoo TICKER MAPPING` to save your Yahoo symbol, for example
`/yahoo VUAA VUAA.L` or `/yahoo 2DGD_EQ 2DG.F`. The command validates the Yahoo
symbol before saving. Mappings are personal, persist across restarts, and take
priority over defaults and administrator environment overrides. Updating a
mapping selects its corresponding cached history on the next `/chart`.
Use `/yahoo TICKER -` to remove your override.

Freedom24 option names convert automatically to Yahoo/OCC contract symbols:
`+AMD.15JAN2027.C280` becomes `AMD270115C00280000`. IBKR compact or padded OCC
symbols are also accepted. Expiry dates and fractional strikes are validated;
options never fall back to the underlying stock or another exchange ticker.
Yahoo must identify the result as an option. Freedom24 historical premiums are
scaled to the broker's per-contract price units using its live contract metadata,
or the standard 100 multiplier for sold contracts (1 for NANOS).
Zero option premiums are valid. Expired histories fetch only through expiry and
remain cached permanently, without requesting unavailable current quotes.

If Yahoo cannot resolve an option or supply its purchase-date history, `/chart`
can fall back to Databento's `OPRA.PILLAR` archive. Set `DATABENTO_API_KEY` (or
`EYRI_DATABENTO_API_KEY`) in the bot environment to enable it. Stocks and ETFs
never use this fallback; successful Yahoo option histories continue using Yahoo.
An explicit `/yahoo` mapping to a stock does not bypass option validation.

Databento's daily OHLCV bars are separate for each exchange. The fallback instead
streams timestamped trades across all exchanges and retains the last traded
premium per New York session. Prices remain per underlying unit; the same broker
contract multipliers and USD conversion apply. Missing trading sessions carry
the previous close, as with Yahoo. No trade-derived daily mark is invented.

Only missing ranges are fetched, in requests of at most 31 days, starting seven
days before the first purchase and ending at the last sale for closed positions,
or at the earlier of expiry and the provider's finalized data boundary. Daily
prices and successful range coverage (including empty sessions) persist in
separate SQLite tables. Failed requests never mark coverage complete. Concurrent
readers share backfills; cached expired histories work after restart even without
an API key. Once selected, cached fallback data is reused without retrying Yahoo.
Live contracts extend their cache as the archive publishes finalized sessions;
availability metadata is free and cached for five minutes. Intraday prices still
come from the broker for the chart's `/alltime` endpoint.

A live probe on 2026-10-07 recovered the expired `+BOTZ.15MAR2024.C33` contract
from Databento after Yahoo failed. If neither source supplies the required option
history, the entire chart still fails; purchase/sale prices or the underlying
stock are not used as invented daily marks.

If any symbol cannot resolve or fetch prices, `/chart` reports the affected
instruments once, with copyable mapping commands, and sends no image:

```text
Failed to fetch historical data:
- /yahoo VUAA VUAA.L
- /yahoo SPYL SPYL.L
```

Successful fetches remain cached for a retry.
A failed Compare leaves the existing chart and participants unchanged.
Unsupported or missing historical prices, unmatched sales and quantities that
disagree with the live broker also cause an error rather than a partial graph.
Complete purchase history is required;
historical short positions are not supported.

Live Yahoo chart-endpoint probes on 2026-10-06 established these usable windows:

| Interval | Successful request | Rejected request |
| --- | --- | --- |
| `1m` | 7 days | 30 days (8-day maximum per request) |
| `5m` | 59 days | 60 and 90 days (recent 60-day boundary) |
| `1h` | 365 and 729 days | 800 days (730-day lookback) |
| `1d` | 1, 10 and 30 years | — |
| `1wk`, `1mo` | 10 years | — |

`/chart` uses `interval=1d` with explicit `period1` / `period2` boundaries at
`https://query1.finance.yahoo.com/v8/finance/chart/{symbol}`. Daily closes cover
long account histories and allow exact missing-range caching; weekly and monthly
bars would obscure purchase and sale dates.

## RSUs

Use `/rsu` to list upcoming vesting dates, current values, and changes since award.
Record an award with a USD price and UTC dates; vesting amounts must total the award:

```text
/rsu AAPL 100 150 24.09.26
24.09.27 50
24.09.28 50
```

Prices are requested from all your IBKR integrations, preferring live quotes
when available. `/rsu` Total sums the listed vestings,
valued at current prices, with the change from award value and the period from
the first award to the final listed vesting date.
Use `/rsu_rm TICKER` to remove all your awards for that ticker.
Use `/rsu_at DD.MM.YYYY` to keep vestings through that date (inclusive), with a
received Total and a Missed total for later vestings. Missed duration runs from the
cutoff to the final vesting date. This preview does not change saved awards.

## Buckets

Use `/buckets` to list buckets, `/bucket new NAME` to create one, and
`/bucket remove NAME` to delete one. Bucket names can contain up to 20 letters,
numbers, and underscores, and must start with a letter.

Use `/bucket move NAME` to render order history with `/move_NAME_IDX` and
`/remove_NAME_IDX` shortcuts. Moving a transaction puts it in that bucket and
removes it from any other bucket. Unbucketed `/perf`, `/alltime`, `/stocks`, `/options`,
`/dpnl`, and `/history` views exclude bucketed transactions; pass `NAME` to
`/perf NAME`, `/alltime NAME`, `/stocks NAME`, `/options NAME`, `/dpnl NAME`, or `/history NAME`
to view a bucket.

## Restarting IB Gateway

The app health check verifies the database and non-IBKR integrations. IBKR
integrations are excluded so a gateway waiting for user 2FA does not make the
app unhealthy.

Gateway automatically restarts daily at 23:59 in the `TIME_ZONE` configured in
`.env-ibkr-1` (currently UTC), replacing its scheduled logoff. This normally
preserves authentication during the week; weekly 2FA is still required.
After pulling this configuration, apply it with
`podman compose up -d --force-recreate ib_gateway` and complete the initial login.

Use `/restart` in Telegram to request an IB Gateway restart for the current
user's IBKR integrations. Each distinct gateway is restarted once. The bot derives the container name from the saved IBKR
`instance_url` host. For example, `ib_gateway:4003` restarts the
`ib_gateway` container.

The app container talks to the host Podman API through
`/run/podman/podman.sock`, which is mounted by `compose.yaml`.

Before starting the compose stack, enable the host user Podman socket:

```sh
systemctl --user enable --now podman.socket
```

`eyri_app` mounts that socket read-write and disables SELinux container
labeling for the service so `/restart` can connect to the socket from inside
the app container. If you use a different in-container socket path, set
`PODMAN_SOCKET_PATH` to match it.
