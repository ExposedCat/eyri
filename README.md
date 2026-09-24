# Stock Manager for Telegram

## Stack

- Interactive Brokers Gateway API
- gnzsnz/ib-gateway
- TypeScript
- grammY
- SQLite

## Integrations

Use `/ibkr [instance_url] [flex_token] [flex_query_id]` in Telegram to persist
an Interactive Brokers integration for the current user.

Use `/f24 [api_key] [secret_key] [history_years]` to persist a Freedom24
integration. `history_years` is optional and defaults to 10.

## RSUs

Use `/rsu` to list upcoming vesting dates, current values, and changes since award.
Record an award with a USD price and UTC dates; vesting amounts must total the award:

```text
/rsu AAPL 100 150 24.09.26
24.09.27 50
24.09.28 50
```

Prices come from your IBKR integration. Total shows shares vested through today,
valued at current prices, with the change from award value and time since the first award.
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
removes it from any other bucket. Unbucketed `/perf`, `/stocks`, `/options`,
`/dpnl`, and `/history` views exclude bucketed transactions; pass `NAME` to
`/perf NAME`, `/stocks NAME`, `/options NAME`, `/dpnl NAME`, or `/history NAME`
to view a bucket.

## Restarting IB Gateway

Gateway automatically restarts daily at 23:59 in the `TIME_ZONE` configured in
`.env-ibkr-1` (currently UTC), replacing its scheduled logoff. This normally
preserves authentication during the week; weekly 2FA is still required.
After pulling this configuration, apply it with
`podman compose up -d --force-recreate ib_gateway` and complete the initial login.

Use `/restart` in Telegram to request an IB Gateway restart for the current
user's IBKR integration. The bot derives the container name from the saved IBKR
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
