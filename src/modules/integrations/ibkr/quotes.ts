import { EventName, IBApi, SecType } from "@stoqey/ib";
import type { Integration } from "../../database/integration.ts";
import { getIbkrHostPort, parseIbkrCredentials } from "./credentials.ts";

export type StockQuote = {
	price?: number;
	delayed: boolean;
	frozen: boolean;
	previousClose: boolean;
	error?: string;
};

const LAST = 4;
const CLOSE = 9;
const DELAYED_LAST = 68;
const DELAYED_CLOSE = 75;

export async function fetchIbkrStockQuotes(
	integration: Integration,
	tickers: string[],
	createApi = (host: string, port: number) => new IBApi({ host, port }),
) {
	const credentials = parseIbkrCredentials(integration.credentials);
	const { host, port } = getIbkrHostPort(credentials.instanceUrl);
	const quotes = new Map<string, StockQuote>();
	const symbols = [...new Set(tickers)];
	if (!symbols.length) return quotes;
	const api = createApi(host, port);
	let connectionError: Error | undefined;
	const onError = (error: Error, code: number, requestId: number) => {
		if (
			(requestId === undefined || requestId < 0) &&
			!(code >= 2100 && code <= 2199)
		) {
			connectionError = error;
		}
	};
	api.on(EventName.error, onError);
	try {
		await new Promise<void>((resolve, reject) => {
			const finish = (error?: Error) => {
				clearTimeout(timer);
				api.off(EventName.nextValidId, onReady);
				api.off(EventName.error, onConnectError);
				api.off(EventName.disconnected, onDisconnected);
				if (error) reject(error);
				else resolve();
			};
			const onReady = () => finish();
			const onDisconnected = () =>
				finish(new Error("IBKR Gateway disconnected."));
			const onConnectError = (error: Error, code: number) => {
				if (!(code >= 2100 && code <= 2199)) finish(error);
			};
			const timer = setTimeout(
				() => finish(new Error("Timed out connecting to IBKR Gateway.")),
				credentials.timeoutMs,
			);
			api.on(EventName.nextValidId, onReady);
			api.on(EventName.error, onConnectError);
			api.on(EventName.disconnected, onDisconnected);
			try {
				api.connect(
					10_000 +
						crypto.getRandomValues(new Uint32Array(1))[0] % 1_000_000_000,
				);
			} catch (error) {
				finish(error instanceof Error ? error : new Error(String(error)));
			}
		});
		api.reqMarketDataType(4);
		for (let offset = 0; offset < symbols.length; offset += 20) {
			const batch = symbols.slice(offset, offset + 20);
			const ticks = new Map<number, Map<number, number>>();
			const quoteById = new Map<number, StockQuote>();
			batch.forEach((ticker, index) => {
				const requestId = offset + index + 1;
				const quote: StockQuote = {
					delayed: true,
					frozen: true,
					previousClose: false,
				};
				quotes.set(ticker, quote);
				quoteById.set(requestId, quote);
				ticks.set(requestId, new Map());
			});
			const onPrice = (requestId: number, tickType: number, price: number) => {
				if (Number.isFinite(price) && price > 0 && price < Number.MAX_VALUE) {
					ticks.get(requestId)?.set(tickType, price);
				}
			};
			const onType = (requestId: number, dataType: number) => {
				const quote = quoteById.get(requestId);
				if (quote) {
					quote.delayed = dataType === 3 || dataType === 4;
					quote.frozen = dataType === 2 || dataType === 4;
				}
			};
			const onQuoteError = (error: Error, _code: number, requestId: number) => {
				const quote = quoteById.get(requestId);
				if (quote) quote.error = error.message;
			};
			api.on(EventName.tickPrice, onPrice);
			api.on(EventName.marketDataType, onType);
			api.on(EventName.error, onQuoteError);
			try {
				batch.forEach((ticker, index) =>
					api.reqMktData(
						offset + index + 1,
						{
							symbol: ticker,
							secType: SecType.STK,
							exchange: "SMART",
							currency: "USD",
						},
						"",
						false,
						false,
					)
				);
				await new Promise((resolve) =>
					setTimeout(resolve, credentials.timeoutMs)
				);
			} finally {
				api.off(EventName.tickPrice, onPrice);
				api.off(EventName.marketDataType, onType);
				api.off(EventName.error, onQuoteError);
				for (const requestId of quoteById.keys()) api.cancelMktData(requestId);
			}
			for (const [requestId, quote] of quoteById) {
				const values = ticks.get(requestId)!;
				const last = values.get(LAST) ?? values.get(DELAYED_LAST);
				const close = values.get(CLOSE) ?? values.get(DELAYED_CLOSE);
				quote.price = last ?? close;
				quote.previousClose = last === undefined && close !== undefined;
				if (quote.price !== undefined) delete quote.error;
				else {quote.error ??= connectionError?.message ??
						"No price returned by IBKR.";}
			}
		}
		return quotes;
	} finally {
		api.disconnect();
		api.off(EventName.error, onError);
	}
}
