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
