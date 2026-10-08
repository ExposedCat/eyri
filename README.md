# Stock Manager for Telegram

## Stack

- Interactive Brokers Gateway API
- gnzsnz/ib-gateway
- TypeScript
- grammY
- SQLite

## Eyri MCP

Eyri exposes the reporting commands as MCP tools at
`http://127.0.0.1:8000/mcp` using stateless Streamable HTTP. The endpoint starts
alongside the bot; Compose publishes port 8000 on the host's loopback interface.
Set `EYRI_MCP_HOST` and `EYRI_MCP_PORT` to change the listener, or set
`EYRI_MCP_PORT=0` to disable it. To run HTTP without starting Telegram, use
`deno task mcp`.

Every tool requires the existing Telegram `userId` as a positive integer.
**Authentication is currently disabled:** the supplied ID selects the user's
portfolio. MCP does not create users; run `/start` in Telegram first.

Tools: `number`, `allnumber`, `perf`, `alltime`, `worth`, `worthnumber`, `stocks`,
`options`, `sold`, `dpnl`, `history`, `when`, `portfolio`, `chart`, `buckets`,
`integrations`, `rsu`, and `rsu_at`. These expose reports; account setup, bucket
changes, RSU edits, and other management commands remain in Telegram.

Portfolio tools accept optional `bucketName`, with the same shared and included
bucket behavior as Telegram. `when` takes a nonempty `prices` object, e.g.
`{"AAPL":150}`, in the user's reporting currency and uses the default portfolio.
`rsu_at` requires `cutoff` as a UTC `YYYY-MM-DD` date. `buckets`, `integrations`,
`rsu`, and `rsu_at` use only the user's own records.

Results contain compact JSON text and the same object in MCP `structuredContent`.
Monetary values use the saved `/currency` preference (USD by default), percentage
values use percentage points (`20` means 20%), and unavailable values are `null`.
Number tools return `{currency,tickers,total}`; detailed reports return positions
and a total. `portfolio` returns allocation weights and values; `chart` returns
daily `{date,pnl,returnPct}` points instead of a PNG. Integration descriptions
mask API keys exactly as Telegram does. Empty portfolios return empty lists and
`total: null`; report failures return `isError: true` and `{error:{code,message}}`.
Broker refreshes use the existing adapters and can update their local caches.

Example MCP client configuration for HTTP:

```json
{
  "mcpServers": {
    "eyri": { "url": "http://127.0.0.1:8000/mcp" }
  }
}
```

For a local stdio client, use `deno task mcp:stdio`, or configure the subprocess
with an absolute project path and the same SQLite database as the bot:

```json
{
  "mcpServers": {
    "eyri": {
      "command": "deno",
      "args": ["run", "-A", "/absolute/path/to/eyri/src/mcp.ts", "--stdio"],
      "cwd": "/absolute/path/to/eyri",
      "env": { "EYRI_DATABASE_PATH": "/absolute/path/to/eyri/data/eyri.sqlite" }
    }
  }
}
```

Standalone MCP does not require `TOKEN` or start Telegram polling or background
IBKR sync loops. When it shares a database with the bot, it can read the bot's
synced broker history. Stdout is reserved for MCP JSON-RPC; logs go to stderr.

## Integrations

Use `/integrations` to manage accounts in a rich message. Each account has an
inline red Delete button. Choose **Add integration**, select **Freedom24**,
**IBKR** or **Trading 212**, and send the requested credentials. `/cancel` cancels
credential entry.
The selected provider is saved per user and chat, including across bot restarts.

Use `/ibkr [instance_url] [flex_token] [flex_query_id]` in Telegram to persist
an Interactive Brokers integration for the current user.

### Second IBKR Gateway with TOTP

`/ibkr` registers an existing Gateway; it does not install or start a container.
`compose.yaml` includes a second live, read-only Gateway with
[ibg-controller](https://github.com/code-hustler-ft3d/ibg-controller)'s automatic
TOTP login. It uses its own settings volume and the same private network as
Eyri. Both Gateway instances are managed by the existing PM3 project.

On the server, in `/home/kitkat/apps/eyri`, create `.env-ibkr-2` from
`.env-ibkr-2.example` and fill `TWS_USERID`, `TWS_PASSWORD`, and `TWOFACTOR_CODE`.
The last value is the Base32 Mobile Authenticator **setup key**, not a rotating
six-digit code. Keep the credentials file permissions at `600`. The controller
requires Mobile Authenticator
to be available for this IBKR username; test its activation before changing other
authentication methods. The controller documents that a single TOTP method is
needed for reliable unattended login.

Run `pm3 restart eyri -d` after filling the file. This installs or restarts both
Gateway instances and Eyri. Check IBKR2 readiness with
`curl -fsS http://127.0.0.1:9082/health`. Login can take a few minutes. If the
account's default connection server is incorrect, set `TWS_SERVER` in the env
file to its actual Gateway server and restart the PM3 project; see the controller's
[bootstrap guide](https://github.com/code-hustler-ft3d/ibg-controller/blob/main/docs/BOOTSTRAP.md).

The new user must configure an XML Activity Flex Query with Trades at Executions
level only, including Symbol, Trade Date, Buy/Sell, Quantity, Trade Price,
Currency, and Asset Category. Select only the account served by this Gateway,
leave symbol filters empty, and choose date format `yyyyMMdd`. Enable Flex Web
Service and obtain its token and the query ID. Then, from their own private
Telegram chat with Eyri, send:

```text
/ibkr tcp://ib_gateway_2:4003 FLEX_TOKEN QUERY_ID
```

The integration belongs to the command sender. `/portfolio` uses the live Gateway;
historical commands need the initial Flex imports to finish. Flex imports one
annual batch every five minutes and defaults to five batches per integration.
The API stays on the private container network; only the health endpoint is
published on the server's loopback interface. VNC is not published.

### Other integrations

Use `/f24 [api_key] [secret_key] [history_years]` to persist a Freedom24
integration. `history_years` is optional and defaults to 10.

Use `/t212 [api_key] [secret_key]` to persist a read-only Trading 212
integration. It always uses the live API. Generate a key and secret in your live
account under Settings → API (Beta), with
Portfolio, Account summary, History - Orders, History - Transactions and history
exports permissions, and leave trading permissions off. Generating a CSV export
uses the dedicated export endpoint; it never places a trade.
Invest and Stocks & Shares ISA accounts are supported.

Trading 212 native prices and executed trades are stored in instrument currency.
Current whole-position reports use the API's account-currency wallet cost, value
and unrealized return, including its FX impact and any costs reflected by the
broker. Reports in that account currency match the supplied valuation exactly;
other reporting currencies convert that valuation using the latest Frankfurter
rates. Sold history preserves each execution's `walletImpact`, including its
currency, realized result, historical FX rate, net cash and taxes. `/sold` uses
the broker's supplied realized P/L; this metric is distinct from net account
return. Partial bucket sales allocate a fill's broker result proportionally to
the selected FIFO quantity. This cannot reconstruct exact tax-lot FX results.
Historical chart points and partial open FIFO holdings still use native trade
costs; historical chart points are estimates, not a historical cash ledger.

For whole Trading 212 accounts, `/alltime` and `/allnumber` use current broker
account value minus external net contributions. The percentage denominator is
net contributions, not cumulative purchase turnover. Complete CSV exports
distinguish true deposits/withdrawals from internal transfers, conversions and
tax adjustments that the cash API labels as deposits. Cash and share quantities
must reconcile with fresh broker data, and imported execution IDs must match the
export. Execution net/gross totals already contain fees and taxes; these are
never deducted twice. An explicit **Account adjustments** row reconciles the
holding and sold-trade rows with account return, including cash FX, dividends,
fees, tax adjustments and differences in broker valuation endpoints. MCP reports
also expose the account value, funding and separate position/summary values.
The live chart endpoint uses the same reconciled total as `/alltime`; earlier
chart points retain the estimate described above.

Exports are cached while event history is unchanged and cash/share checks pass.
On first use or after new activity, T212 may need a minute to prepare an export;
the command requests it and asks for a retry instead of displaying an incomplete
total. A pending export is reused on retry. Account reconciliation applies only
when the complete account is included. Individual/excluded/shared bucket subsets
continue to show selected investment results. External funding in other
currencies, non-account-currency cash without a broker breakdown, unsupported
cash actions and outstanding CFD funding cause explicit errors rather than an
invented consolidated balance. In particular, a current CFD account value is
required before outstanding transfer funding can be treated as wealth.
US equity IDs such as `AAPL_US_EQ` display as `AAPL`; other listing IDs are preserved.
Order history is cached in SQLite and paginated, then refreshed incrementally at
most once per minute. A large first import can take time because of API rate limits.
Unsupported corporate actions cause history-based calculations to report an error
rather than produce misleading FIFO results. Portfolio views without bucket
allocations use live equity holdings and cached CFD cash history; equity order
history is imported only when a report needs it.
Daily P&L is unavailable because the API provides no previous-close baseline.

Trading 212 cash history is imported automatically for portfolio and historical
reports; enable read-only **History - Transactions** permission as well.
Each internal transfer out buys one synthetic CFD allocation at its USD funding
cost. Each return sells all allocations funded since the previous return, with
the returned cash as total sale proceeds. Sending $500 and returning $1,000
therefore gives $500 cost and $500 realized profit (+100%), using the same FIFO,
bucket, performance and chart paths as ordinary purchases and sales. `/history`
shows the $500 purchase, as it does for other purchased instruments.
Outstanding allocations appear in `/stocks`, `/portfolio`, `/perf`, `/worth`
and their bucket views at funding cost until a return closes them. `/sold`,
`/alltime`, `/allnumber` and `/chart` include realized CFD results. Whole-account
reconciliation includes returned CFD cash through the actual cash ledger rather
than relying on today's conversion of the synthetic trade result. Historical chart values
stay at funding cost between transfers and never request market prices for CFD.
A return without outstanding funding is additional zero-basis proceeds; it
does not create a short position. Existing CFD bucket assignments migrate to
the individual purchase keys.
This is an explicit transfer accounting convention, not live CFD valuation:
the public API supplies no CFD positions and does not identify the destination
of an internal transfer. All amounts use current USD conversion rates.

Use `/currency CODE` (for example `/currency EUR`) to save your reporting
currency across chats and restarts. Any currency accepted by the existing
Frankfurter conversion service is supported, including GBX pence. `/currency`
shows your current preference; `/currency USD` resets it to the default.
All monetary reports, charts, RSU values and diagnostic dumps use your selected
currency, including shared buckets viewed by you. GBX is treated as pence
(100 GBX = 1 GBP) before conversion. Long portfolio and bucket messages continue across
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

`/stocks`, `/options`, `/perf`, `/number`, `/worth`, `/worthnumber`, `/sold`,
`/alltime`, `/allnumber`, `/dpnl`, `/history`, `/when`, bucket views and diagnostic
dumps display amounts in your selected currency (default USD) using the latest
Frankfurter rates. Prices supplied to `/when` use your selected currency. History prices and realized
gains use the same current FX rates as holdings; FIFO matching and bucket shortcuts
retain their original transaction identity. Price, cost and P&L calculations stay
in instrument currency (including EUR warrant quotes); completed results are
converted to your selected currency before reporting totals, sorting and rendering. `/when`
targets are normalized to instrument currency before those calculations.
A required FX failure reports an error
instead of displaying a partial total.

Recognized Vontobel warrants use the issuer's current EUR bid for live portfolio
values and returns, instead of IBKR's portfolio mark. Broker purchase costs,
including commissions, are preserved. Quotes are verified against the issuer,
product type and holding currency before bucket allocation or report calculations.
If a required bid cannot be loaded, the report fails instead of using the broker
mark. Diagnostic dumps include the quote source and timestamp.

Rich integration controls use Telegram Bot API 10.3's `sendRichMessage`, inline
`RichTextButton` and `InputRichBlockButtons`. A small typed raw API wrapper
allows these methods to work with the currently installed grammY version.

Freedom24 holdings and book cost come from the live portfolio, preserving ticker
changes and stock splits. Daily P&L uses the broker's previous-day portfolio P&L;
instruments with no trade today show zero, as in Freedom24. The total daily
percentage uses current portfolio value, matching the app's summary. Historical
orders supply holding dates when their tickers still match.

## Ticker icons and labels

`/decorate TICKER EMOJI`, `/label TICKER LABEL`, and `/link TICKER TAG` use
global defaults with personal overrides, including in shared bucket views. The
first value set for each ticker and command becomes the global default. Once a
default exists, subsequent changes apply only to the user issuing the command,
including the user who originally set the default. Other users keep the default.
`/label TICKER false` hides the label and `/link TICKER false` removes the link
for that scope, overriding any inherited or automatic link.

Existing global icons remain defaults. Older personal icon assignments migrate
to one shared set per ticker; if they differ, the most recently updated complete
set wins. Existing personal labels and links are preserved, with the most recently
updated value for each ticker also becoming its initial global default. Generated
emoji-pack icons and `/yahoo` historical-price mappings remain global.

## Shared buckets

Create a bucket with `/bucket new NAME`, then use `/bucket move NAME` to assign
purchase transactions. `/bucket transfer NAME` grants read-only access to the
author of the message you reply to. `/bucket transfer NAME TELEGRAM_ID` grants
access by numeric Telegram user ID, even before that person starts the bot.
The recipient must not already own or have access to a bucket with that name.
Ownership and broker credentials remain with the original owner; recipients
cannot change the bucket's trades or grant someone else access.

Shared buckets appear in `/buckets` and work with named views such as
`/perf NAME`, `/worth NAME`, `/worthnumber NAME`, `/options NAME`, `/alltime NAME`,
`/history NAME`, and `/chart NAME`.
The owner's integrations provide the holdings and purchase/sale history. The
recipient does not need an integration of their own to view a shared bucket.

Use `/bucket include NAME` to merge an accessible bucket into your default
portfolio reports, including `/portfolio`, `/stocks`, `/options`, `/perf`,
`/alltime`, `/sold`, `/dpnl`, `/history`, `/number`, `/worth`, `/worthnumber`,
`/when`, and `/chart`.
Repeated inclusion does not duplicate holdings. Matching holdings are combined;
FIFO remains independent for each broker account, and realized gains follow the
bucket of the original purchase. `/bucket exclude NAME` undoes inclusion without
removing access. Owners can also include their own buckets in their default view.

`/bucket remove NAME` removes a recipient's access without affecting the owner's
bucket. If the owner removes the bucket, all grants and inclusions are removed.
`/integrations` and `/restart` continue to manage only the sender's own accounts.

## All-time performance

Use `/alltime` (or `/alltime BUCKET`) to combine `/perf` and `/sold` into one
line per ticker and a single Total. Gains include current holdings and realized
FIFO gains from available order history. Percentages use their combined cost
basis. Sold lots follow the bucket of their purchase transaction; unbucketed
views exclude bucketed lots unless explicitly included. Periods run from the earliest purchase to today for
current holdings, or the final sale for fully sold holdings.

Use `/number` or `/allnumber` for the same totals as `/perf` or `/alltime`
in a compact format: available ticker icons on one line, a separator, and only
the total dollar gain or loss. Icons are deduplicated; tickers without an icon
are omitted from the icon line but still count toward the total. Both commands
accept an optional bucket name.

Use `/worth` for the same layout and percentage returns as `/perf`, with current
holding values in your selected currency and their total replacing dollar gains or losses. `/worthnumber`
shows the same ticker icons and separator as `/number`, followed by only the current
total value in your selected currency. Both commands accept an optional bucket name and use the same
holdings, including any included buckets.

## Portfolio chart

Use `/portfolio` (or `/portfolio BUCKET`) to chart stock allocation, largest first.
Bars show each holding's share of stock market value, with losing holdings below
zero. Below each ticker are its percentage return and monetary gain or loss.
All holdings are combined into one chart in your selected currency using the latest Frankfurter exchange
rates for values, purchase costs, and monetary returns. GBX is converted as pence
(100 GBX = 1 GBP) before conversion. Matching tickers are merged after conversion;
allocation weights and the header total use the selected currency. Large portfolios
use one wider image, sent as an original PNG file to preserve sharp text when zooming.
If a required exchange rate is unavailable, the command reports an error.
Charts render directly in Deno using Chart.js and `@napi-rs/canvas` from npm.
The container includes DejaVu Sans fonts; local runs use installed system fonts.

## All-time chart

Use `/chart` (or `/chart BUCKET`) for a daily time series of current plus realized
performance. The percentage is gain divided by the cost of open holdings plus
FIFO-matched sold lots, as in `/alltime`. The graph starts at the first purchase;
sales retain their realized gains, weekends carry the last close, and stock splits
adjust historical quantities and unit costs. Today's endpoint uses broker prices
and book cost. All amounts use the latest exchange rates consistently across
the series, excluding historical FX effects, dividends and fees.

The chart is sent as a Telegram photo using the portfolio's dark background,
mint gains and pink losses. Every month has a label and a vertical grid line;
the plot and participant legend fill the image, with no header or footer.
**Compare** adds the person clicking the button to that same graph, up to six
participants. A single chart displays monetary gains in the author's selected
currency. Compare switches all participants to USD, including the original chart;
percentages and published snapshots are preserved without refetching their accounts.
Published curves remain snapshots of what their owners shared;
the button fetches the clicker's accounts and included shared buckets. Buttons are bound to their
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
symbol before saving. Mappings apply to every user, persist across restarts, and take
priority over defaults and administrator environment overrides. Updating a
mapping selects its corresponding cached history on the next `/chart`.
Use `/yahoo TICKER -` to remove the global override for everyone. Existing personal
overrides are migrated into the global table on startup; when they conflict, the
most recently written saved override wins. Existing global overrides take precedence
over migrated ones. Automatically resolved symbols remain in the history cache.

Vontobel warrants resolve automatically from their German WKN (for example
`VY8GR5` or `VY8GTE`), a German exchange suffix (`.DE`, `.F`, `.SG`), or a
broker-provided ISIN. Eyri derives and validates the ISIN check digit, then checks
Vontobel's product metadata for the issuer, warrant type and quote currency.
Global `/yahoo` mappings and administrator Yahoo overrides remain authoritative.
The issuer's lifetime chart supplies daily bid quotes in EUR per warrant; the
underlying stock series and warrant exercise ratio are not used as prices.
Finalized bids persist in SQLite, and recent history refreshes after five minutes.
Sold positions can reuse cached finalized ranges without contacting Vontobel.
No API key or manual symbol mapping is needed. The website endpoint is
undocumented; provider failures report unavailable Vontobel warrant history.

Freedom24 option names convert automatically to Yahoo/OCC contract symbols:
`+AMD.15JAN2027.C280` becomes `AMD270115C00280000`. IBKR compact or padded OCC
symbols are also accepted. Expiry dates and fractional strikes are validated;
options never fall back to the underlying stock or another exchange ticker.
Yahoo must identify the result as an option. Freedom24 historical premiums are
scaled to the broker's per-contract price units using its live contract metadata,
or the standard 100 multiplier for sold contracts (1 for NANOS).
Zero option premiums are valid. Expired histories fetch only through expiry and
remain cached permanently, without requesting unavailable current quotes.

Verified corporate actions preserve purchase lots in `/chart` and `/alltime`:
VSCO/VSCO.US joins VSXY/VSXY.US using Yahoo's combined VSXY history. APH option
splits on June 12, 2024 and September 3, 2026 double contract quantities and halve
strikes and unit costs. The chart stitches the predecessor strike's historical
premiums into the adjusted contract, preserving original bucket assignments.
A holding without matching purchases reports missing purchase history rather
than suggesting an unrelated `/yahoo` mapping.

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
removes it from any other bucket. Unbucketed `/perf`, `/number`, `/worth`,
`/worthnumber`, `/alltime`, `/allnumber`, `/stocks`, `/options`, `/dpnl`, and
`/history` views exclude bucketed transactions; pass `NAME` to
`/perf NAME`, `/number NAME`, `/worth NAME`, `/worthnumber NAME`, `/alltime NAME`,
`/allnumber NAME`, `/stocks NAME`, `/options NAME`, `/dpnl NAME`, or `/history NAME`
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
