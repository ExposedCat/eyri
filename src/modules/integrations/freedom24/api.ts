const TRADERNET_API_BASE = "https://tradernet.com/api/v2/cmd";

type TradernetApiError = {
  error?: unknown;
  message?: unknown;
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
    order?: Freedom24Order[];
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
  op?: string | number;
  close_price?: string | number;
  ClosePrice?: string | number;
};

export type Freedom24Order = {
  instr?: string;
  date?: string;
  oper?: number;
  p?: number;
  q?: number;
  curr?: string;
  curr_c?: string;
  base_currency?: string;
  base_contract_code?: string;
  stat?: number;
  trade?: Freedom24Trade[];
};

export type Freedom24Trade = {
  p?: number;
  q?: number;
  v?: number;
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
  const error = body.error ?? body.message;
  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }
  return null;
}

export async function makeTradernetApiRequest<T>(
  apiKey: string,
  secretKey: string,
  cmd: string,
  params: Record<string, string> = {},
): Promise<T> {
  const nonce = Date.now().toString();
  let signatureString = `apiKey=${apiKey}&cmd=${cmd}&nonce=${nonce}`;

  if (Object.keys(params).length > 0) {
    const paramString = Object.entries(params)
      .map(([key, value]) => `${key}=${value}`)
      .join("&");
    signatureString += `&params=${paramString}`;
  }

  const bodyParams = new URLSearchParams({ apiKey, cmd, nonce });
  for (const [key, value] of Object.entries(params)) {
    bodyParams.append(`params[${key}]`, value);
  }

  const response = await fetch(`${TRADERNET_API_BASE}/${cmd}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      "X-NtApi-PublicKey": apiKey,
      "X-NtApi-Sig": await signTradernetRequest(secretKey, signatureString),
    },
    body: bodyParams.toString(),
  });

  const text = await response.text();
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

  const tradernetError =
    body && typeof body === "object"
      ? getTradernetErrorMessage(body as TradernetApiError)
      : null;
  if (tradernetError) {
    throw new Error(`Freedom24 ${cmd} failed: ${tradernetError}`);
  }

  return body as T;
}
