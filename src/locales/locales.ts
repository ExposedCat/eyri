export const locales: Record<string, Record<string, string>> = {
  en: {
    start: `Eyri (Icelandic "penny") manages your investment performance.\n\nUse /ibkr to set up an Interactive Brokers integration.\nUse /f24 to set up a Freedom24 integration.\nUse /integrations to see configured integrations.\nUse /tickers to see your positions performance.\nUse /perf to see concise performance.\nUse /daily to see daily performance.\nUse /history to see your order history.\nUse /restart to restart the bot.`,
    no_positions: `No positions were returned by your configured integrations.`,
    when: `To see hypothetical performance, use this format:\n\n<code>/when TICKER=price TICKER2=price2 ...</code>`,
    decorate: `To decorate a ticker, use this format:\n\n<code>/decorate TICKER EMOJI</code>`,
    label: `To set or hide a ticker label, use this format:\n\n<code>/label TICKER LABEL</code>\n\nUse <code>false</code> as the label to hide it.`,
    link: `To link a ticker label, use this format:\n\n<code>/link TICKER TAG</code>\n\nUse <code>false</code> as the tag to remove it.`,
    integrations: `Use /ibkr to set up an Interactive Brokers integration or /f24 to set up Freedom24.`,
    no_integrations: `No integrations are configured yet.\n\nUse /ibkr to set up Interactive Brokers or /f24 to set up Freedom24.`,
    ibkr: `To set up Interactive Brokers, use this format:\n\n<code>/ibkr [instance_url] [flex_token] [flex_query_id]</code>\n\nExample:\n<code>/ibkr ib_gateway:4003 FLEX_TOKEN FLEX_QUERY_ID</code>`,
    f24: `To set up Freedom24, use this format:\n\n<code>/f24 [api_key] [secret_key] [history_years]</code>\n\n<code>history_years</code> is optional and defaults to 10.\n\nCreate API credentials at Freedom24/Tradernet Auth API and do not enable trading permissions.`,
    integration_saved: `Integration has been saved.\n\nUse /tickers, /perf, /daily, or /history to fetch broker data.`,
    integration_save_failed: `Failed to save integration.`,
    integration_delete: `To delete an integration, use this format:\n\n<code>/integration_delete ibkr</code>\nor\n<code>/integration_delete f24</code>`,
    integration_deleted: `Integration has been deleted.`,
    integration_not_found: `Integration was not found.`,
  },
};
