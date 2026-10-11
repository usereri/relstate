// A strict, read-only JSON-RPC proxy for the browser (`POST /api/rpc`).
//
// Why it exists: the app cannot use the public devnet endpoint (it answers 429 almost at once) and
// must not carry the backend's paid RPC key in a production bundle. So the browser talks to us, and
// we talk to the configured upstream. What makes that safe to leave unauthenticated:
//
//   * a method allowlist of reads only: nothing that sends, signs, airdrops or subscribes;
//   * per-method parameter checks where a read can still be abused (getProgramAccounts is limited
//     to our program and the token programs, and must carry a filter);
//   * a request body cap, a batch cap and an upstream timeout and response cap;
//   * the upstream request is rebuilt from the validated fields rather than forwarded raw;
//   * the upstream URL and key never appear in a response, an error or a log line.
import { ASSOCIATED_TOKEN_PROGRAM, RELSTATE_PROGRAM, TOKEN_2022_PROGRAM } from "./contracts.ts";

const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

/** Reads only. Each entry is the maximum number of items its first parameter may carry, or 0 for "no list". */
const ALLOWED: Readonly<Record<string, number>> = {
  getAccountInfo: 0,
  getMultipleAccounts: 100,
  getProgramAccounts: 0,
  getBalance: 0,
  getLatestBlockhash: 0,
  isBlockhashValid: 0,
  getSignatureStatuses: 100,
  getTokenAccountBalance: 0,
  getTokenSupply: 0,
  getSlot: 0,
  getBlockHeight: 0,
  getMinimumBalanceForRentExemption: 0,
  simulateTransaction: 0,
};

const PROGRAMS_FOR_GPA: ReadonlySet<string> = new Set([RELSTATE_PROGRAM, TOKEN_PROGRAM, TOKEN_2022_PROGRAM, ASSOCIATED_TOKEN_PROGRAM]);

export type RpcProxyOptions = {
  /** Read lazily so a test (or a config reload) can change it. */
  upstreamUrl: () => string;
  fetch?: typeof fetch;
  maxBatch?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
};

export type ProxyResult = { status: number; body: string; retryAfter?: string };

export const RPC_PROXY_MAX_BODY_BYTES = 64 * 1024;

type Call = { jsonrpc: "2.0"; id: string | number | null; method: string; params: unknown[] };

class Invalid extends Error {
  readonly id: string | number | null;
  constructor(message: string, id: string | number | null = null) {
    super(message);
    this.id = id;
  }
}

const rpcError = (id: string | number | null, code: number, message: string): string => JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function validate(raw: unknown): Call {
  if (!isPlainObject(raw)) throw new Invalid("request must be a JSON-RPC object");
  const id = raw.id;
  if (!(id === null || typeof id === "string" || typeof id === "number")) throw new Invalid("id must be a string, number or null");
  if (raw.jsonrpc !== "2.0") throw new Invalid("jsonrpc must be \"2.0\"", id);
  const method = raw.method;
  if (typeof method !== "string" || !Object.hasOwn(ALLOWED, method)) throw new Invalid("method not allowed", id);
  const params = raw.params ?? [];
  if (!Array.isArray(params) || params.length > 3) throw new Invalid("params must be an array of at most 3 items", id);

  const listCap = ALLOWED[method] as number;
  if (listCap > 0) {
    const list = params[0];
    if (!Array.isArray(list) || list.length === 0 || list.length > listCap) throw new Invalid(`${method} takes 1 to ${listCap} items`, id);
  }
  if (method === "getProgramAccounts") {
    const program = params[0];
    if (typeof program !== "string" || !PROGRAMS_FOR_GPA.has(program)) throw new Invalid("program not allowed", id);
    const config = params[1];
    const filters = isPlainObject(config) ? config.filters : undefined;
    // Unfiltered, this dumps every account of a token program. Our own accounts are always read through a filter too.
    if (!Array.isArray(filters) || filters.length === 0 || filters.length > 4) throw new Invalid("getProgramAccounts needs 1 to 4 filters", id);
  }
  return { jsonrpc: "2.0", id, method, params };
}

/** Pulls the secret out of an upstream URL (`?api-key=…` or a `/v2/<key>` path) so it can be scrubbed from anything we relay. */
function secretsIn(url: string): string[] {
  const out: string[] = [];
  try {
    const u = new URL(url);
    const key = u.searchParams.get("api-key");
    if (key) out.push(key);
    for (const segment of u.pathname.split("/")) if (segment.length >= 16) out.push(segment);
    if (u.password) out.push(u.password);
  } catch {
    /* an unparseable URL has nothing to scrub, and nothing will be fetched from it either */
  }
  return out;
}

export function createRpcProxy(options: RpcProxyOptions) {
  const doFetch = options.fetch ?? fetch;
  const maxBatch = options.maxBatch ?? 10;
  const maxResponse = options.maxResponseBytes ?? 8 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 15_000;

  /** Calls the limiter would count for this body: one per batch item. Unparseable bodies count as one. */
  function weight(body: unknown): number {
    return Array.isArray(body) ? Math.max(1, Math.min(body.length, maxBatch)) : 1;
  }

  async function handle(rawBody: string, limit: (calls: number) => void): Promise<ProxyResult> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      limit(1);
      return { status: 400, body: rpcError(null, -32700, "parse error") };
    }
    limit(weight(parsed));

    let payload: Call | Call[];
    try {
      if (Array.isArray(parsed)) {
        if (parsed.length === 0 || parsed.length > maxBatch) throw new Invalid(`batch must hold 1 to ${maxBatch} requests`);
        payload = parsed.map(validate);
      } else {
        payload = validate(parsed);
      }
    } catch (e) {
      if (e instanceof Invalid) return { status: 400, body: rpcError(e.id, -32600, e.message) };
      throw e;
    }

    const upstream = options.upstreamUrl();
    const secrets = secretsIn(upstream);
    const scrub = (text: string) => secrets.reduce((t, s) => t.split(s).join("<redacted>"), text);
    const fail = (status: number, message: string, retryAfter?: string): ProxyResult => ({
      status,
      body: rpcError(null, -32000, message),
      ...(retryAfter ? { retryAfter } : {}),
    });

    try {
      const res = await doFetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) return fail(429, "upstream rate limit, retry shortly", res.headers.get("retry-after") ?? undefined);
      if (!res.ok) return fail(502, "upstream RPC unavailable");
      const text = await res.text();
      if (text.length > maxResponse) return fail(502, "upstream response too large");
      return { status: 200, body: scrub(text) };
    } catch {
      return fail(502, "upstream RPC unavailable");
    }
  }

  return { handle };
}

export type RpcProxy = ReturnType<typeof createRpcProxy>;
