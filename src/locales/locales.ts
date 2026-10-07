export const locales: Record<string, Record<string, string>> = {
  en: {
    start:
      `Eyri (Icelandic "penny") manages your investment performance.\n\nUse /ibkr to set up an Interactive Brokers integration.\nUse /f24 to set up a Freedom24 integration.\nUse /t212 to set up a Trading 212 integration.\nUse /integrations to add and manage integration accounts.\nUse /buckets to see portfolio buckets.\nUse /bucket new NAME, /bucket remove NAME, or /bucket move NAME to manage buckets.\nUse /bucket transfer NAME [TELEGRAM_ID] to share a bucket (or reply to its recipient).\nUse /bucket include NAME or /bucket exclude NAME to merge or unmerge a bucket in your portfolio.\nUse /stocks to see stock performance.\nUse /portfolio to chart stock allocation.\nUse /rsu to record awards and see upcoming vesting.\nUse /rsu_rm TICKER to remove RSU awards.\nUse /rsu_at DD.MM.YYYY to preview a vesting cutoff.\nUse /options to see option performance.\nUse /perf to see concise performance.\nUse /number to see ticker icons and current total gain.\nUse /worth to see current USD value and percentage returns.\nUse /worthnumber to see ticker icons and current total value.\nUse /sold to see sold position performance.\nUse /alltime to see combined current and sold performance.\nUse /allnumber to see ticker icons and all-time total gain.\n\nUse /chart to graph and compare all-time performance.\nUse /yahoo TICKER MAPPING to set a historical-price symbol.\nUse /dpnl to see daily performance.\nUse /history to see your order history.\nUse /createpack to create ticker emoji fallbacks.\nUse /syncpack to add new ticker emoji fallbacks.\nUse /removepack to remove ticker emoji fallbacks.\nUse /restart to restart IB Gateway.`,
    no_positions: `No positions were returned by your configured integrations.`,
    when:
      `To see hypothetical performance with prices in USD, use this format:\n\n<code>/when TICKER=price TICKER2=price2 ...</code>`,
    decorate:
      `To decorate a ticker, use this format:\n\n<code>/decorate TICKER EMOJI</code>`,
    label:
      `To set or hide a ticker label, use this format:\n\n<code>/label TICKER LABEL</code>\n\nUse <code>false</code> as the label to hide it.`,
    link:
      `To link a ticker label, use this format:\n\n<code>/link TICKER TAG</code>\n\nUse <code>false</code> as the tag to remove it.`,
    integrations:
      `Use /ibkr to set up an Interactive Brokers integration or /f24 to set up Freedom24, or /t212 to set up Trading 212.`,
    no_integrations:
      `No integrations are configured yet.\n\nUse /integrations to add an account, or /ibkr, /f24 and /t212 to enter credentials directly.`,
    ibkr:
      `To set up Interactive Brokers, use this format:\n\n<code>/ibkr [instance_url] [flex_token] [flex_query_id]</code>\n\nExample:\n<code>/ibkr ib_gateway:4003 FLEX_TOKEN FLEX_QUERY_ID</code>`,
    f24:
      `To set up Freedom24, use this format:\n\n<code>/f24 [api_key] [secret_key] [history_years]</code>\n\n<code>history_years</code> is optional and defaults to 10.\n\nCreate API credentials at Freedom24/Tradernet Auth API and do not enable trading permissions.`,
    t212:
      `To set up Trading 212, use this format:\n\n<code>/t212 [api_key] [secret_key]</code>\n\nGenerate a key and secret in Settings → API (Beta) for your live Invest or Stocks &amp; Shares ISA account. Enable read-only Portfolio, History - Orders and History - Transactions permissions; leave trading permissions disabled.`,
    integration_saved:
      `Integration has been saved.\n\nUse /stocks, /perf, /dpnl, or /history to fetch broker data.`,
    integration_save_failed: `Failed to save integration.`,
    integration_delete:
      `Use an account's Delete button in /integrations, or:\n\n<code>/integration_delete NUMBER</code>\n\nUse the number shown in your /integrations list.`,
    integration_deleted: `Integration has been deleted.`,
    integration_not_found: `Integration was not found.`,
  },
};
