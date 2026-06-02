export const locales: Record<string, Record<string, string>> = {
  en: {
    start: `Eyri (Icelandic "penny") manages your investment performance.\n\nUse /buy to add a position purchase item.\nUse /delete to remove the last purchase item for a position.\nUse /tickers to see your positions performance.\nUse /perf to see concise performance.\nUse /history to see your purchase history.`,
    buy: `To add a position purchase item, use this format:\n\n<code>/buy [ticker] [price] [commission] [amount]</code>`,
    bought: `Position purchase item has been successfully added.\n\nUse /tickers to see your positions performance.`,
    delete: `To delete the last purchase item for a position, use this format:\n\n<code>/delete [ticker]</code>`,
    deleted: `Last position purchase item has been successfully deleted.\n\nUse /history to see your purchase history.`,
    delete_not_found: `No position purchase item was found for this ticker.`,
    no_positions: `You don't have any positions yet.\n\nUse /buy to add a position purchase item.`,
    when: `To see hypothetical performance, use this format:\n\n<code>/when TICKER=price TICKER2=price2 ...</code>`,
    decorate: `To decorate a ticker, use this format:\n\n<code>/decorate TICKER EMOJI</code>`,
    label: `To set or hide a ticker label, use this format:\n\n<code>/label TICKER LABEL</code>\n\nUse <code>false</code> as the label to hide it.`,
    link: `To link a ticker label, use this format:\n\n<code>/link TICKER TAG</code>\n\nUse <code>false</code> as the tag to remove it.`,
  },
};
