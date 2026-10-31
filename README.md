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

For Context's Finance MCP integration under PM3, both app containers join the
external `finance-mcp` network. Create it once with
`podman network exists finance-mcp || podman network create finance-mcp`, then
recreate both projects using PM3 after updating their repositories. Context
connects to `http://eyri_app:8000/mcp`; set `FINANCE_MCP_NETWORK` in both projects'
`.env` files if the network has another name. The external network survives
PM3's Compose down/up restarts, and port 8000 remains published only on loopback.

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
values use percentage points (`20` means 20%). Missing required numeric data
fails the report with `isError: true`; it is never rendered as a placeholder.
Empty reports and optional metadata can still use `null`.
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

The second Gateway uses the unmodified, pinned controller image.
`EXISTING_SESSION_DETECTED_ACTION=primary` accepts session-conflict prompts,
and `BYPASS_WARNING=Continue Login,Reconnect This Session` also handles those
buttons if they appear after authentication while the API is starting.
These settings let the Gateway take over an existing session with the same
username. The stock upstream watchdog relaunches a disconnected Gateway after
its grace period; it does not immediately dismiss session prompts during normal
monitoring. Using the same IBKR username in another app can still displace it.

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
Currency, and Asset Category. For account returns, also include Account Information
(Account ID, Currency, Date Opened, Date Funded), Cash Transactions (Account ID, Currency,
FX Rate to Base, Report Date, Date/Time, Amount, Type, Transaction ID), Cash Report (Base Currency
Summary, Starting Cash, Ending Cash, Deposits, Withdrawals), and Change in NAV
(Starting Value, Deposits/Withdrawals). Include all cash types without filters.
Select only the account served by this Gateway,
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

An optional fourth argument, `FUNDING_QUERY_ID`, selects a separate Activity Flex
Query for funding when the existing trade query is a Trade Confirmation query.
Funding loads consecutive annual statements back to Date Funded (or Date Opened
when Date Funded is absent), anchoring full annual batches at that date so
a late-night first deposit and its report day stay together. It validates cash
continuity and reconciles Cash Transactions against Cash Report and Change in NAV.
Requests using the same token are paced together, including trade imports.
Historical transaction FX rates convert contributions into account base currency;
Gateway NetLiquidation and TotalCashValue supply the live balance and cash.
Native cash transactions, including dividends and withholding, are retained for
historical reconstruction. The trade Flex Query must include commissions for
account cash charts. Existing imported fills backfill commission fields on demand;
missing fees are never silently replaced with zero for account-ledger charts.
Flex only publishes completed days. If live cash differs from the latest statement,
the report fails with an explicit reconciliation error until the next daily statement;
it does not treat an unverified same-day deposit as profit. Missing sections,
truncated history, unsupported asset transfers and failed broker requests are errors.

### Other integrations

Use `/f24 [api_key] [secret_key] [history_years]` to persist a Freedom24
integration. `history_years` is optional and defaults to 10.

Freedom24 account returns use a complete `getBrokerReport` from 1970 through today,
independently of `history_years`. Approved, unreversed bank/card/crypto funding and
account transfers use the broker's historical USD values. Dividends, interest,
taxes and fees remain in account P/L. Opposite account transfers cancel when both
accounts are selected. The report's current cash, including debit balances, and
net assets supply the account result; quantities must match the live portfolio.

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
Historical holdings use execution wallet costs where available and daily market
prices. The complete CSV cash ledger supplies dated trade cash, conversions,
income and tax movements without deducting execution charges a second time.

For whole Trading 212 accounts, `/alltime` and `/allnumber` use current broker
account value minus external net contributions. The percentage denominator is
gross external deposits; reinvested gains do not count as new deposits. Complete CSV exports
distinguish true deposits/withdrawals from internal transfers, conversions and
tax adjustments that the cash API labels as deposits. Cash and share quantities
must reconcile with fresh broker data, and imported execution IDs must match the
export. Execution net/gross totals already contain fees and taxes; these are
never deducted twice. Instrument rows show holding and sold-trade P/L. The Total
uses account value and funding directly, including cash, FX, dividends and fees.
Funded P/L is calculated in the broker account's base currency before display
conversion. For example, a CZK-funded account displayed in USD includes currency
gains that USD instrument price P/L does not, so the instrument rows need not sum
to the account Total.
MCP reports also expose the account value, funding and separate position/summary values.
The lifetime chart endpoint uses the same monetary total and gross-deposit return
as `/alltime`. Earlier account points replay the dated cash and execution ledger.

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
Outstanding allocations appear in `/perf stocks`, `/portfolio`, `/perf`, `/worth`
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
Telegram messages without changing transaction button numbers.
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

`/perf`, `/number`, `/worth`, `/worthnumber`, `/sold`,
`/alltime`, `/allnumber`, `/dpnl`, `/history`, `/when`, bucket views and diagnostic
dumps display amounts in your selected currency (default USD) using the latest
Frankfurter rates. Prices supplied to `/when` use your selected currency. History prices and realized
gains use the same current FX rates as holdings; FIFO matching and bucket buttons
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
If the product-detail snapshot omits its bid, Eyri requests the issuer's dedicated
latest-price endpoint and keeps that quote's timestamp.
Verified live bids persist in SQLite. If a refresh fails, reports reuse the last
saved bid and append ⚠️ to the affected price or performance row. Cached bids keep
their original timestamp and have no expiry; a successful refresh clears the warning.
If no live bid has been saved yet, Eyri reuses the latest previously cached daily
Vontobel bid, with ⚠️ and its original date. This includes history saved before live
quote caching was added. If neither cache has a verified bid, the report still fails.
Diagnostic dumps include the quote source, timestamp and cache status; daily
fallbacks use `vontobel_daily_bid`.

Stock-only reports skip warrant issuer quote requests entirely, including stock
filters on performance, worth, daily, all-time, number and historical chart commands,
stock allocation charts, stock dumps and MCP stock reports. Bucket and account
funding calculations retain the broker holdings they need; an excluded warrant's
issuer feed cannot block a stock-only report.

Rich integration and bucket controls use Telegram Bot API 10.3's `sendRichMessage`,
inline `RichTextButton` and `InputRichBlockButtons` (bucket history uses rich HTML
with `<tg-button>`). A small typed raw API wrapper
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
for that scope, overriding any inherited or automatic link. Quote a ticker that
contains spaces: `/label "NVS Dec17'27 230 Call" Novartis call` (typographic
quotes also work).

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

Add a percentage to grant part of a bucket: `/bucket transfer NAME 50 TELEGRAM_ID`,
or reply with `/bucket transfer NAME 50%` (the `%` is required when no ID follows,
because a lone number is a Telegram ID). Decimals are allowed, from above 0 up to
100. The recipient's bucket contains the given share of every quantity, cost,
value, P&L, sale and history entry; unit prices and percentages are unchanged.
The share is applied when reports are built, so the owner's later Move/Remove
changes appear in the recipient's bucket at that share. The owner always sees
100% of the bucket. For the recipient it works like any other shared bucket,
including `/bucket include`. `/buckets` shows the share.

Grants split the bucket: all recipients together can hold at most 100%. You can
grant 50% and 50% to two users, but not 50% and 60%; a grant without a
percentage is 100% and uses the whole bucket. The owner's `/buckets` shows how
much has been transferred. Granting the same bucket to the same user again with a
different percentage replaces their share, and a recipient's `/bucket remove NAME`
frees it. Grants made before this limit existed are kept as they are. Buckets from one owner
can be included together at any shares.

Shared buckets appear in `/buckets` and work with named views such as
`/perf NAME`, `/worth NAME`, `/worthnumber NAME`, `/perf options NAME`, `/alltime NAME`,
`/history NAME`, and `/chart NAME`.
The owner's integrations provide the holdings and purchase/sale history. The
recipient does not need an integration of their own to view a shared bucket.
For bucket returns, each purchase is assumed to use fresh cash. Sale proceeds
remain bucket cash rather than funding later purchases. Contributions, cash and
the index's purchase schedule scale with the granted share. Complete accounts
continue to use broker-reported deposits, preserving their reinvestment treatment.
When your own portfolio excludes buckets, their cash purchase costs are allocated
out of your actual account deposits, and their equity—including retained sale
proceeds—is excluded from account value. Sales do not return that capital to the
remaining portfolio. Including an owned bucket again restores its allocation;
owned buckets are never added twice to the broker's deposits.

Use `/bucket include NAME` to merge an accessible bucket into your default
portfolio reports, including `/portfolio`, `/perf`,
`/alltime`, `/sold`, `/dpnl`, `/history`, `/number`, `/worth`, `/worthnumber`,
`/when`, and `/chart`.
Repeated inclusion does not duplicate holdings. Matching holdings are combined;
FIFO remains independent for each broker account, and realized gains follow the
bucket of the original purchase. `/bucket exclude NAME` undoes inclusion without
removing access. Owners can also include their own buckets in their default view.

`/bucket remove NAME` removes a recipient's access without affecting the owner's
bucket. If the owner removes the bucket, all grants and inclusions are removed.
`/integrations` and `/restart` continue to manage only the sender's own accounts.

## Performance commands

Use `/KIND[@bot_username] [s/o/stocks/options] [BUCKET]`, where `KIND` is
`perf`, `dpnl`, `alltime`, or `worth`. Both arguments are optional; put the
asset filter before the bucket. `s` and `stocks` select stocks/CFDs; `o` and
`options` select options and warrants. Without a filter, both are included.
For example: `/perf s`, `/dpnl options Core`, `/worth Core`, or
`/alltime@eyri_bot stocks Core`. `/number`, `/allnumber`, and `/worthnumber`
also accept these filters. Filter words in the first argument are reserved.
The separate `/stocks` and `/options` commands have been removed.

Filtered `/alltime` views show selected open and sold P/L without allocating
account cash. Bucket views use the fresh-cash purchase assumption described above.

## All-time performance

Use `/alltime` (or `/alltime BUCKET`) to combine `/perf` and `/sold` into one
line per ticker and a single Total. Gains include current holdings and realized
FIFO gains from available order history. Ticker rows show monetary P/L without a
lifetime percentage. The whole-account Total uses
`(cash + portfolio + withdrawals - deposits) / deposits * 100`, including cash in
account equity and using gross deposits as the denominator. Reinvestments are not
new deposits. Withdrawals preserve previously earned profit. Zero deposits or
incomplete funding leave the percentage unavailable while preserving monetary P/L.
Whole Trading 212 and Freedom24 accounts supply this reconciliation. Whole IBKR
accounts require the Activity Flex funding sections described above. Buckets use
the fresh-cash purchase assumption; filtered and unreconciled views may still lack
a capital-return percentage. Combined
accounts containing unclassified internal transfers also omit the percentage so
those transfers cannot inflate deposits. `/allnumber` continues to show monetary P/L.
Sold lots follow the bucket of their purchase transaction; unbucketed
views exclude bucketed lots unless explicitly included. Periods run from the earliest purchase to today for
current holdings, or the final sale for fully sold holdings. Unknown purchase dates
omit the optional holding period and monthly rates. Missing required prices, costs,
daily P/L or RSU quotes fails the relevant report instead of showing partial totals.

Use `/number [perf|alltime|worth|dpnl] [s|stocks|o|options] [BUCKET]` for
the selected report's exact total as ticker icons, a separator, and one number.
The default is `perf`. `/allnumber` and `/worthnumber` remain aliases for
`/number alltime` and `/number worth`. Icons are deduplicated; missing icons do
not exclude a ticker from the total. Options includes warrants.

Use `/worth` for current holding values plus a separate Cash line and their total
in the selected currency. Per-holding percentages retain `/perf`'s open-position
meaning. Complete-account totals use broker equity, matching `/alltime`'s account
valuation, including any broker accruals. Asset-filtered worth reports contain only the selected holdings, without
assigning account cash to stocks or options. Included buckets retain their cash
from sold positions. `/number worth` and `/worthnumber` use exactly the same total.

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

## Report charts

Use `/chart [perf|alltime|worth] [s|stocks|o|options] [BUCKET]` for a daily
chart of the corresponding report. The default is `alltime`; `/chart BUCKET`
continues to work. The live endpoint comes from the same calculation as the text
report and `/number KIND`.

`perf` shows open-position P/L and return on the remaining book cost. Sales remove
the sold lots' open P/L. `alltime` retains realized results and reconstructs cash
from native deposits, withdrawals, executions, currency conversions, dividends,
taxes and fees, using daily FX. Reinvestment never adds deposits. `worth` plots
holdings plus cash as a monetary value, including changes from contributions.
Cash-funded buckets use the agreed fresh-cash purchase model and keep sale proceeds.
Filtered reports use only selected instruments and do not allocate account cash.
Cash balances and held quantities must reconcile before a ledger chart is published.
Missing cash, fee or FX history fails explicitly instead of substituting a trade-only
curve. Weekends carry the last close; splits preserve quantities and cost basis.
IBKR contract exchange and ISIN metadata distinguish unrelated listings sharing a
ticker, including London CURE versus the US leveraged ETF.

The chart is sent as a Telegram photo using the portfolio's dark background.
Single-portfolio charts keep a solid mint actual-performance line above and below
zero, including when the benchmark is unavailable, and use an opaque
gold dashed **if S&P 500** line. Comparisons keep each participant's own color
for their solid and opaque dashed lines. Benchmark lines draw behind actual
lines; hollow circles draw on top. They mark turning points and the endpoint, with a
minimum spacing to avoid crowding.
For complete accounts, the dashed line invests each external deposit into fractional shares of
**CSPX.L**, the accumulating USD iShares S&P 500 ETF, at that date's closing price
(or the preceding close). Withdrawals sell hypothetical units and remain part of
lifetime proceeds. Actual purchases and reinvestments add no benchmark capital
for completed statement dates. For `/chart perf`, IBKR purchases made today after
the funding statement cutoff provisionally add their full purchase costs to the
index, even when funded by sales or existing cash. Available commissions are
included; sales and FX conversions do not offset or add provisional funding.
This assumption affects only the benchmark. Running `/chart perf` again after
the next statement covers that day replaces the estimate with actual deposits
and withdrawals; previously sent charts remain saved snapshots. This mode does
not require live cash to match the completed statement. Account-wide `alltime`
and `worth` reconciliation remains unchanged.
Non-USD deposits buy ETF shares using their funding-date FX
rate. Daily ETF values include currency movement in the broker account's base
currency, then convert to the display currency, matching the account Total's
funding basis. Both daily FX rates and contribution values are frozen with the
chart for index switching; unavailable historical FX omits the benchmark rather
than substituting today's rate. Bucket benchmarks instead receive fresh cash on each selected
purchase date, scaled by the user's share; bucket sale proceeds remain cash.
Allocations to excluded owned buckets reduce the remaining account's benchmark
capital on their purchase dates; they are distinct from external withdrawals.
Benchmark return is `(remaining value + withdrawals - deposits) / deposits * 100`.
Benchmarks require complete dated external funding and are omitted when it is
unavailable or the hypothetical fund cannot cover a withdrawal. Existing chart
sessions made with purchase-cost returns or the previous funding FX calculation
must be recreated with `/chart`.
The two curves and monetary gains appear together in the participant legend.
All three kinds show the same buy-and-hold index portfolio: `perf` displays its
open-position P/L, `alltime` its funding-based lifetime P/L, and `worth` its value.
Ordinary stock sales and reinvestments never sell or buy index units. For example,
buying a stock for $10, selling it for $100 and reinvesting $100 contributes only
$10 to the index if the original top-up was $10. Every top-up is invested immediately,
including money left idle in the actual account. Asset filters change the actual
holdings curve; the index retains the same full portfolio funding schedule.
The explicit fresh-cash purchase assumption for shared buckets is retained.
Compare retains the original chart's kind and asset filter.
The **S&P 500** button beside Compare switches the index to **Momentum**, using
the USD **IUMO.L** ETF with the same external funding schedule. Clicking
**Momentum** switches back to S&P 500. The button names the current selection,
changes every participant's benchmark together, and also appears on its own in DMs.
Joining an existing chart uses that chart's selected index.

Each personal benchmark and its USD purchase schedule are saved with the owner's
published snapshot. Switching indices never refetches broker accounts; once
calculated, both index curves are retained so toggling back restores the same snapshot.
Comparisons clip them to the original chart window while retaining the effect of purchases made
before that window. Missing history rejects the chart rather than moving purchases
to a different date; older charts without personal benchmarks must be recreated
with `/chart`.
In group chats, **Compare** adds the person clicking the button to that same graph,
up to six participants. DMs have no Compare button. While adding a participant,
the button shows **Adding NAME...** and further clicks on either button are rejected
until it finishes. Index changes show **Switching...** and share the same lock.
Comparisons keep the original chart's start and end dates, trimming added histories
to that span without rebasing their returns. A single chart displays monetary gains in the author's selected
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
Warrants with newer WKN prefixes (such as `BD4BJ2`) also use this lookup.
When broker classification is missing, WKN-shaped codes containing digits are
checked with the issuer; explicitly classified stocks are not guessed this way.
Global `/yahoo` mappings and administrator Yahoo overrides remain authoritative.
The issuer's lifetime chart supplies daily bid quotes in EUR per warrant; the
underlying stock series and warrant exercise ratio are not used as prices.
Finalized bids persist in SQLite, and recent history refreshes after five minutes.
Sold positions can reuse cached finalized ranges without contacting Vontobel.
No API key or manual symbol mapping is needed. The website endpoint is
undocumented; provider failures report unavailable Vontobel warrant history.

Morgan Stanley warrants (for example `MN03RW` / `DE000MN03RW5`) also resolve
automatically after checking the issuer's product page for the ISIN, warrant
type and currency. Its five-year chart supplies daily EUR bids per warrant;
the underlying stock and exercise ratio are not substituted for warrant prices.
Prices persist in SQLite and refresh after five minutes. History must cover the
purchase date, and an unavailable feed reports a Morgan Stanley history error
instead of suggesting an invalid `/yahoo` mapping. These website endpoints are
undocumented; no API key is required.

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
Stock holdings with no recorded purchase start at the current chart endpoint;
no earlier acquisition date is assumed. Their current book cost and value match
the corresponding report. This chart fallback does not add broker trades or
change bucket assignments. Other instruments without
matching purchases report missing purchase history rather than suggesting an
unrelated `/yahoo` mapping.

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
Complete purchase history is required except for stock holdings with no recorded
purchase, which use the free-stock assumption above. Historical short positions
are not supported.

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

Use `/bucket move NAME` to render order history as a rich message with an inline
button on each order: a red **Move** puts the order in the bucket, and once moved
it becomes a green **Remove**. Each click edits the message in place instead of
sending a new one. Long histories are split into messages of 100 orders. Only the
user who ran the command can press the buttons. Moving a transaction puts it in
that bucket and removes it from any other bucket.

Use `/bucket move NAME TICKER AMOUNT` (e.g. `/bucket move Core AAPL 5`) to move
part of a holding. `TICKER` can be the full broker ticker or its base (`AAPL` for
`AAPL.US`); `AMOUNT` is a share count and may be fractional. Shares come from the
oldest purchases still held in the portfolio (already sold quantities and
bucketed orders are skipped), so the bucket's cost basis comes from those
purchases. A split purchase appears in `/bucket move NAME` as two lines, the
portfolio part and the bucket part, each with its own button; **Remove** on the
bucket part returns those shares to the portfolio. Within a split purchase, later
sales use the portfolio part first. Recipients of the bucket see partial parts
like any other bucket content and lose them when they are returned. Removing the
bucket returns all of its shares. Synthesized entries such as T212 CFD funding
cannot be split.

Unbucketed `/perf`, `/number`, `/worth`,
`/worthnumber`, `/alltime`, `/allnumber`, `/dpnl`, and
`/history` views exclude bucketed transactions; pass `NAME` to
`/perf NAME`, `/number NAME`, `/worth NAME`, `/worthnumber NAME`, `/alltime NAME`,
`/allnumber NAME`, `/dpnl NAME`, or `/history NAME`
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
