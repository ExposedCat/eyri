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

## Restarting IB Gateway

Use `/restart` in Telegram to request an IB Gateway restart for the current
user's IBKR integration. The bot derives the container name from the saved IBKR
`instance_url` host. For example, `ib_gateway:4003` restarts the
`ib_gateway` container.

The app container talks to the host Podman API through
`/run/podman/podman.sock`, which is mounted by `compose.yaml`.
