import { deepStrictEqual, equal, rejects } from "node:assert/strict";
import { EventEmitter } from "node:events";
import { EventName, type IBApi } from "@stoqey/ib";
import type { Integration } from "../../database/integration.ts";
import { fetchIbkrStockQuotes } from "./quotes.ts";

class QuoteApi extends EventEmitter {
	requested: string[] = [];
	cancelled: number[] = [];
	disconnected = false;
	ready = true;
	connect() {
		this.emit(
			EventName.error,
			new Error("Market data farm connected"),
			2104,
			-1,
		);
		if (this.ready) this.emit(EventName.nextValidId, 1);
	}
	reqMarketDataType(type: number) {
		equal(type, 4);
	}
	reqMktData(
		requestId: number,
		contract: { symbol: string; currency: string },
		generic: string,
		snapshot: boolean,
		regulatory: boolean,
	) {
		equal(contract.currency, "USD");
		equal(generic, "");
		equal(snapshot, false);
		equal(regulatory, false);
		this.requested.push(contract.symbol);
		this.emit(EventName.tickPrice, requestId + 1000, 4, 999);
		if (contract.symbol === "AAPL") {
			this.emit(EventName.marketDataType, requestId, 1);
			this.emit(EventName.tickPrice, requestId, 9, 80);
			this.emit(EventName.tickPrice, requestId, 4, 120);
		} else if (contract.symbol === "MSFT") {
			this.emit(EventName.marketDataType, requestId, 3);
			this.emit(EventName.tickPrice, requestId, 68, 200);
		} else if (contract.symbol === "GOOG") {
			this.emit(EventName.marketDataType, requestId, 4);
			this.emit(EventName.tickPrice, requestId, 68, -1);
			this.emit(EventName.tickPrice, requestId, 75, 150);
		} else {
			this.emit(EventName.tickPrice, requestId, 4, Number.MAX_VALUE);
			this.emit(EventName.error, new Error("Unknown contract"), 200, requestId);
		}
	}
	cancelMktData(requestId: number) {
		this.cancelled.push(requestId);
	}
	disconnect() {
		this.disconnected = true;
	}
}

const integration: Integration = {
	id: 1,
	userId: 1,
	kind: "ibkr",
	createdAt: new Date(),
	updatedAt: new Date(),
	credentials: { instanceUrl: "localhost:4001", timeoutMs: 10 },
};

Deno.test("IBKR quotes distinguish live, delayed, previous close and unavailable prices", async () => {
	const api = new QuoteApi();
	const quotes = await fetchIbkrStockQuotes(integration, [
		"AAPL",
		"MSFT",
		"GOOG",
		"INVALID",
		"AAPL",
	], () => api as unknown as IBApi);
	deepStrictEqual(quotes.get("AAPL"), {
		price: 120,
		delayed: false,
		frozen: false,
		previousClose: false,
	});
	deepStrictEqual(quotes.get("MSFT"), {
		price: 200,
		delayed: true,
		frozen: false,
		previousClose: false,
	});
	deepStrictEqual(quotes.get("GOOG"), {
		price: 150,
		delayed: true,
		frozen: true,
		previousClose: true,
	});
	equal(quotes.get("INVALID")?.price, undefined);
	equal(quotes.get("INVALID")?.error, "Unknown contract");
	deepStrictEqual(api.requested, ["AAPL", "MSFT", "GOOG", "INVALID"]);
	deepStrictEqual(api.cancelled, [1, 2, 3, 4]);
	equal(api.disconnected, true);
	deepStrictEqual(api.eventNames(), []);
});

Deno.test("IBKR quote connection timeout disconnects and removes listeners", async () => {
	const api = new QuoteApi();
	api.ready = false;
	await rejects(
		fetchIbkrStockQuotes(integration, ["AAPL"], () => api as unknown as IBApi),
		/Timed out connecting/,
	);
	equal(api.disconnected, true);
	deepStrictEqual(api.eventNames(), []);
});
