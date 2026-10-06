# Stock Manager for Telegram

## Stack

- Interactive Brokers Gateway API
- gnzsnz/ib-gateway
- TypeScript
- grammY
- SQLite

## Integrations

Use `/integrations` to manage accounts in a rich message. Each account has an
inline red Delete button. Choose **Add integration**, select **Freedom24** or
**IBKR**, and send the requested credentials. `/cancel` cancels credential entry.
The selected provider is saved per user and chat, including across bot restarts.

Use `/ibkr [instance_url] [flex_token] [flex_query_id]` in Telegram to persist
an Interactive Brokers integration for the current user.

Use `/f24 [api_key] [secret_key] [history_years]` to persist a Freedom24
integration. `history_years` is optional and defaults to 10.

Both commands keep their existing formats; each successful submission adds a
new account. Users can connect multiple accounts from the same provider. Use
`/integration_delete ID` or the account's Delete button to remove one account.
The old `/integration_delete ibkr` or `/integration_delete f24` shortcut works
only when the user has exactly one account of that provider.

Portfolio, stocks, options, performance, daily P&L and history fetch each saved
account independently. Matching holdings are combined by ticker and currency,
with summed values and weighted prices; sold gains are calculated separately
for each account before aggregation. Provider-specific daily P&L baselines are
preserved. If any account fails, the command identifies it instead of displaying
an incomplete total. Existing accounts and cached broker history are preserved
by an automatic database migration on startup.

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
zero and returns below tickers. Currencies are charted separately; large portfolios
continue across images. The header is the total stock value for that currency.
The container includes Python and Matplotlib for rendering; local runs need
`python3` with `matplotlib==3.11.2` installed.

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
