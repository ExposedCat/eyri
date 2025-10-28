import { savePrice } from "../database/price.ts";
import type { Database } from "../database/setup.ts";

type RealtimePayload =
	| [
			"q",
			{
				c: string;
				contract_multiplier?: number;
				bbp?: number;
				ltp?: number;
				delta?: number;
				theta?: number;
				ClosePrice?: number;
			},
	  ]
	| [
			"userData",
			{
				mode: "prod" | "demo";
			},
	  ];

export class TradenetRealtime {
	private ws: WebSocket | null = null;
	private reconnectTimeout: number | null = null;
	private isAuthenticated: boolean = false;
	private isIntentionallyDisconnected: boolean = false;
	private wsUrl: string = "";
	private subscriptions: Set<string> = new Set();
	private database: Database;

	constructor(database: Database) {
		this.database = database;
	}

	connect(sessionId?: string) {
		if (sessionId) {
			this.wsUrl = `wss://wss.tradernet.com/?SID=${sessionId}`;
		}

		return new Promise((resolve) => {
			this.ws = new WebSocket(this.wsUrl);

			const timeout = setTimeout(() => {
				if (this.ws) {
					this.ws.close();
				}
				resolve(false);
			}, 10000);

			this.ws.addEventListener("message", async (data) => {
				try {
					const rawMessage = data.data.toString();
					const message: RealtimePayload = JSON.parse(rawMessage);

					if (Array.isArray(message) && message.length >= 2) {
						const [type, payload] = message;

						if (type === "userData" && payload.mode === "prod") {
							clearTimeout(timeout);
							this.isAuthenticated = true;
							this.sendQuotes(this.subscriptions);
							resolve(true);
						} else if (type === "q" && payload.c) {
							await this.handleQuote(message);
						}
					}
				} catch (error) {
					console.error("[WS] Error processing WebSocket message:", error);
				}
			});

			this.ws.addEventListener("error", (error) => {
				console.error("[WS] Error:", error);
				clearTimeout(timeout);
				resolve(false);
			});

			this.ws.addEventListener("close", () => {
				this.isAuthenticated = false;
				clearTimeout(timeout);

				if (!this.isIntentionallyDisconnected) {
					this.scheduleReconnection();
				}

				resolve(false);
			});
		});
	}

	disconnect() {
		this.isIntentionallyDisconnected = true;
		this.isAuthenticated = false;

		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
			this.reconnectTimeout = null;
		}

		if (this.ws) {
			this.ws.close();
			this.ws = null;
		}

		this.wsUrl = "";
		this.subscriptions.clear();
	}

	subscribe(ticker: string) {
		if (this.subscriptions.has(ticker)) {
			return;
		}
		this.subscriptions.add(ticker);
		this.sendQuotes(this.subscriptions);
	}

	unsubscribe(ticker: string) {
		if (!this.subscriptions.has(ticker)) {
			return;
		}
		this.subscriptions.delete(ticker);
		this.sendQuotes(this.subscriptions);
	}

	private async handleQuote([kind, payload]: RealtimePayload) {
		if (kind !== "q" || !payload.c) {
			return;
		}
		const ticker = payload.c;
		const price = payload.bbp ?? payload.ltp ?? 0;
		const closePrice = payload.ClosePrice;
		if (price > 0) {
			await savePrice({
				database: this.database,
				ticker,
				price,
				closePrice,
			});
		}
	}

	private sendQuotes(subscriptions: Iterable<string>) {
		if (
			!this.ws ||
			this.ws.readyState !== WebSocket.OPEN ||
			!this.isAuthenticated
		) {
			return;
		}
		this.ws.send(JSON.stringify(["quotes", Array.from(subscriptions)]));
	}

	private scheduleReconnection(): void {
		if (this.reconnectTimeout) {
			clearTimeout(this.reconnectTimeout);
		}

		this.reconnectTimeout = setTimeout(async () => {
			if (!this.isIntentionallyDisconnected) {
				const success = await this.connect();
				if (!success) {
					this.scheduleReconnection();
				}
			}
		}, 5_000);
	}
}
