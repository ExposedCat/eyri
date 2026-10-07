import { logFetch } from "../../../utils/fetch_logging.ts";

const TRADERNET_API_BASE = "https://tradernet.com/api/v2/cmd";

type TradernetApiError = {
  error?: unknown;
  message?: unknown;
  errMsg?: unknown;
};

type TradernetParams = { [key: string]: string | number | TradernetParams };

type TradernetRequestOptions = {
  onRawResponse?: (text: string) => void;
};

export type Freedom24PortfolioResponse = {
  result?: {
    ps?: {
      acc?: Freedom24AccountCurrency[];
      pos?: Freedom24PortfolioPosition[];
    };
  };
};

export type Freedom24AccountCurrency = {
  curr?: string;
  s?: number;
};

export type Freedom24PortfolioPosition = {
  s?: number;
  fv?: string | number;
  mkt_price?: number;
  price_a?: number;
  face_val_a?: number;
  market_value?: number;
  profit_close?: number;
  profit_price?: number;
  q?: number;
  curr?: string;
  close_price?: number;
  maturity_d?: string;
  base_currency?: string;
  base_contract_code?: string;
  i?: string;
};

export type Freedom24OrderHistoryResponse = {
  orders?: {
    order?: Freedom24Order[] | null;
  };
};

export type Freedom24QuotesResponse = {
  result?: {
    q?: Freedom24Quote[] | Record<string, Freedom24Quote>;
  };
};

export type Freedom24Quote = {
  c?: string;
  ltp?: string | number;
  bbp?: string | number;
  bap?: string | number;
  pp?: string | number;
  p5?: string | number;
  op?: string | number;
  close_price?: string | number;
  ClosePrice?: string | number;
  marketStatus?: string;
  ltt?: string;
  UTCOffset?: string | number;
};

export type Freedom24Order = {
  id?: string | number;
  instr?: string;
  date?: string;
  oper?: string | number;
  p?: string | number;
  q?: string | number;
  cur?: string;
  curr?: string;
  curr_c?: string;
  base_currency?: string;
  base_contract_code?: string;
  stat?: string | number;
  trade?: Freedom24Trade[];
};

export type Freedom24Trade = {
  id?: string | number;
  p?: string | number;
  q?: string | number;
  v?: string | number;
  fv?: string | number;
  profit?: number;
  date?: string;
};

function toHex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

async function signTradernetRequest(
  secretKey: string,
  signatureString: string,
) {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secretKey),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(signatureString),
  );
  return toHex(signature);
}

function getTradernetErrorMessage(body: TradernetApiError) {
  const error = body.error ?? body.message ?? body.errMsg;
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return null;
}

// Tradernet SDK StringUtils.str_from_dict recursively sorts raw values for
// signing; its http_build_query encodes nested objects with PHP bracket keys.
function signatureParams(params: TradernetParams): string {
  return Object.entries(params).map(([key, value]) =>
    `${key}=${typeof value === "object" ? signatureParams(value) : value}`
  ).sort().join("&");
}

function appendParams(
  body: URLSearchParams,
  params: TradernetParams,
  prefix = "",
) {
  for (const [key, value] of Object.entries(params)) {
    const name = prefix ? `${prefix}[${key}]` : key;
    if (typeof value === "object") appendParams(body, value, name);
    else body.append(name, String(value));
  }
}

export async function makeTradernetApiRequest<T>(
  apiKey: string,
  secretKey: string,
  cmd: string,
  params: TradernetParams = {},
  options: TradernetRequestOptions = {},
): Promise<T> {
  const operation = `Freedom24 ${cmd}${
    params.tickers ? ` tickers=${params.tickers}` : ""
  }`;
  return await logFetch(operation, async () => {
    const nonce = Date.now().toString();
    const payload: TradernetParams = { apiKey, cmd, nonce };
    if (Object.keys(params).length) payload.params = params;
    const signatureString = signatureParams(payload);
    const bodyParams = new URLSearchParams();
    appendParams(bodyParams, payload);

    const response = await fetch(`${TRADERNET_API_BASE}/${cmd}`, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-NtApi-PublicKey": apiKey,
        "X-NtApi-Sig": await signTradernetRequest(secretKey, signatureString),
      },
      body: bodyParams.toString(),
      signal: AbortSignal.timeout(30_000),
    });

    const text = await response.text();
    options.onRawResponse?.(text);
    let body: unknown;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = null;
    }

    if (!response.ok) {
      throw new Error(
        `Freedom24 ${cmd} failed: ${response.status} ${response.statusText}${
          text ? ` - ${text.slice(0, 500)}` : ""
        }`,
      );
    }

    const tradernetError = body && typeof body === "object"
      ? getTradernetErrorMessage(body as TradernetApiError)
      : null;
    if (tradernetError) {
      throw new Error(`Freedom24 ${cmd} failed: ${tradernetError}`);
    }

    return body as T;
  });
}
