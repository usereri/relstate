// A strict, read-only JSON-RPC proxy for the browser (`POST /api/rpc`).
//
// Why it exists: the app cannot use the public devnet endpoint (it answers 429 almost at once) and
// must not carry the backend's paid RPC key in a production bundle. So the browser talks to us, and
// we talk to the configured upstream. What makes that safe to leave unauthenticated:
//
//   * a method allowlist of reads only: nothing that sends, signs, airdrops or subscribes;
//   * per-method parameter checks where a read can still be abused: getProgramAccounts is limited
//     to OUR program and must select one account type by its discriminator; simulateTransaction
//     is size- and shape-bounded; token-program scans are not offered at all;
//   * a request body cap, a batch cap, an upstream timeout, and a response cap enforced while
//     streaming (the body is never buffered past it);
//   * a limiter that charges work (not calls) per IP, plus a process-wide budget;
//   * the upstream request is rebuilt from the validated fields rather than forwarded raw;
//   * the upstream URL and key never appear in a response, an error or a log line.
import { getBase58Encoder } from "@solana/kit";
import { RELSTATE_PROGRAM } from "./contracts.ts";

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

/**
 * Work, in limiter units, that one call costs the paid upstream. A plain read is 1; a list method
 * costs its list length; the two expensive scans cost a flat amount. The limiter charges this, not
 * the call count, so a 1,000-account request cannot hide behind ten hits.
 */
export const GPA_WEIGHT = 50;
export const SIMULATE_WEIGHT = 20;

export type ProxyResult = { status: number; body: string; retryAfter?: string };

export const RPC_PROXY_MAX_BODY_BYTES = 64 * 1024;

type Call = { jsonrpc: "2.0"; id: string | number | null; method: string; params: unknown[]; weight: number };

class Invalid extends Error {
  readonly id: string | number | null;
  constructor(message: string, id: string | number | null = null) {
    super(message);
    this.id = id;
  }
}

const rpcError = (id: string | number | null, code: number, message: string): string => JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } });

const isPlainObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

const isInt = (v: unknown, min: number, max: number): v is number => typeof v === "number" && Number.isInteger(v) && v >= min && v <= max;

const base58 = getBase58Encoder();
/** Decoded length of a base58 string, or null when it is not valid base58. */
function base58Length(text: string): number | null {
  try {
    return base58.encode(text).length;
  } catch {
    return null;
  }
}

const GPA_KEYS = new Set(["encoding", "commitment", "filters", "withContext", "dataSlice", "minContextSlot"]);

/**
 * A getProgramAccounts request is accepted only if it selects: a well-formed filter set that
 * includes a memcmp on the 8-byte account discriminator at offset 0. That scopes the scan to one
 * account type of OUR program (bounded by our own state, and by the response cap). `dataSize` and
 * empty or short memcmps match everything and are refused.
 */
function checkGetProgramAccounts(params: unknown[], id: string | number | null): void {
  if (params[0] !== RELSTATE_PROGRAM) throw new Invalid("program not allowed", id);
  const config = params[1];
  if (!isPlainObject(config)) throw new Invalid("getProgramAccounts needs a config with filters", id);
  for (const key of Object.keys(config)) if (!GPA_KEYS.has(key)) throw new Invalid(`unsupported option ${key}`, id);
  const filters = config.filters;
  if (!Array.isArray(filters) || filters.length === 0 || filters.length > 4) throw new Invalid("getProgramAccounts needs 1 to 4 filters", id);
  let selectsType = false;
  for (const f of filters) {
    if (!isPlainObject(f)) throw new Invalid("malformed filter", id);
    const keys = Object.keys(f);
    if (keys.length !== 1) throw new Invalid("malformed filter", id);
    if (keys[0] === "dataSize") {
      if (!isInt(f.dataSize, 1, 10_240)) throw new Invalid("malformed dataSize filter", id);
    } else if (keys[0] === "memcmp") {
      const m = f.memcmp;
      if (!isPlainObject(m) || !isInt(m.offset, 0, 1024) || typeof m.bytes !== "string" || m.bytes.length === 0 || m.bytes.length > 64) {
        throw new Invalid("malformed memcmp filter", id);
      }
      if (m.encoding !== undefined && m.encoding !== "base58") throw new Invalid("memcmp must use base58", id);
      const len = base58Length(m.bytes);
      if (len === null || len === 0) throw new Invalid("memcmp bytes are not base58", id);
      if (m.offset === 0 && len === 8) selectsType = true;
    } else {
      throw new Invalid("unknown filter", id);
    }
  }
  if (!selectsType) throw new Invalid("getProgramAccounts must filter on an account discriminator", id);
}

const SIM_KEYS = new Set(["encoding", "commitment", "sigVerify", "replaceRecentBlockhash", "accounts", "minContextSlot"]);

/** 1232 raw bytes is the transaction limit; base64 of that is 1644 characters. */
function checkSimulate(params: unknown[], id: string | number | null): void {
  if (typeof params[0] !== "string" || params[0].length === 0 || params[0].length > 2048) throw new Invalid("simulateTransaction takes one encoded transaction", id);
  const config = params[1];
  if (config === undefined) return;
  if (!isPlainObject(config)) throw new Invalid("malformed simulateTransaction config", id);
  for (const key of Object.keys(config)) if (!SIM_KEYS.has(key)) throw new Invalid(`unsupported option ${key}`, id);
  if (config.sigVerify === true && config.replaceRecentBlockhash === true) throw new Invalid("sigVerify and replaceRecentBlockhash are exclusive", id);
  const accounts = config.accounts;
  if (accounts !== undefined) {
    if (!isPlainObject(accounts) || !Array.isArray(accounts.addresses) || accounts.addresses.length > 5) throw new Invalid("at most 5 accounts may be returned", id);
  }
}

function validate(raw: unknown): Call {
  if (!isPlainObject(raw)) throw new Invalid("request must be a JSON-RPC object");
  const id = raw.id;
  if (!(id === null || typeof id === "string" || typeof id === "number")) throw new Invalid("id must be a string, number or null");
  if (raw.jsonrpc !== "2.0") throw new Invalid("jsonrpc must be \"2.0\"", id);
  const method = raw.method;
  if (typeof method !== "string" || !Object.hasOwn(ALLOWED, method)) throw new Invalid("method not allowed", id);
  const params = raw.params ?? [];
  if (!Array.isArray(params) || params.length > 3) throw new Invalid("params must be an array of at most 3 items", id);

  let weight = 1;
  const listCap = ALLOWED[method] as number;
  if (listCap > 0) {
    const list = params[0];
    if (!Array.isArray(list) || list.length === 0 || list.length > listCap) throw new Invalid(`${method} takes 1 to ${listCap} items`, id);
    weight = list.length;
  }
  if (method === "getProgramAccounts") {
    checkGetProgramAccounts(params, id);
    weight = GPA_WEIGHT;
  }
  if (method === "simulateTransaction") {
    checkSimulate(params, id);
    weight = SIMULATE_WEIGHT;
  }
  return { jsonrpc: "2.0", id, method, params, weight };
}

/**
 * Everything that must never be relayed: the upstream URL itself, each of its query values, path
 * segments and credentials whatever they are called, and any configured key. Over-redacting a
 * short string is harmless in an error relayed to a browser; leaking a key is not.
 */
function secretsFor(url: string, extra: string[]): string[] {
  const out = new Set<string>([url, ...extra.filter((e) => e.length >= 6)]);
  try {
    const u = new URL(url);
    for (const v of u.searchParams.values()) if (v.length >= 4) out.add(v);
    for (const segment of u.pathname.split("/")) if (segment.length >= 6) out.add(segment);
    if (u.password) out.add(u.password);
    if (u.username.length >= 4) out.add(u.username);
  } catch {
    /* an unparseable URL has nothing more to scrub, and nothing will be fetched from it either */
  }
  // Longest first, so the full URL goes before the pieces it contains.
  return [...out].sort((a, b) => b.length - a.length);
}

export class UpstreamTooLarge extends Error {}

/** Reads a response body incrementally, cancelling it the moment it passes `max` BYTES. */
async function readCapped(res: Response, max: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => {});
    throw new UpstreamTooLarge();
  }
  if (res.body === null) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      throw new UpstreamTooLarge();
    }
    chunks.push(value);
  }
  const all = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    all.set(c, at);
    at += c.byteLength;
  }
  return new TextDecoder().decode(all);
}

/** Thrown by an admission function when a caller has spent its share. */
export class RpcRateLimited extends Error {
  readonly scope: "ip" | "global";
  readonly retryAfterSeconds: number;
  constructor(scope: "ip" | "global", retryAfterSeconds: number) {
    super("rate limit exceeded");
    this.scope = scope;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * Work-weighted admission: a per-key budget per minute plus one process-wide budget, both fixed
 * windows. A caller whose address could not be resolved (`unknown`) shares a tenth of the per-IP
 * budget, so the degraded case fails safe instead of becoming one generous shared bucket.
 */
export function createRpcLimiter(opts: { perIpPerMinute: number; globalPerMinute: number; now?: () => number; maxKeys?: number }) {
  const now = opts.now ?? Date.now;
  const maxKeys = opts.maxKeys ?? 50_000;
  const hits = new Map<string, { start: number; used: number }>();
  let global = { start: now(), used: 0 };
  return function admit(key: string, weight: number): void {
    const t = now();
    if (t - global.start >= 60_000) global = { start: t, used: 0 };
    const globalWait = Math.max(1, Math.ceil((global.start + 60_000 - t) / 1000));
    if (global.used + weight > opts.globalPerMinute) throw new RpcRateLimited("global", globalWait);
    let h = hits.get(key);
    if (h === undefined || t - h.start >= 60_000) {
      hits.delete(key);
      while (hits.size > 0 && hits.size >= maxKeys) hits.delete(hits.keys().next().value as string);
      h = { start: t, used: 0 };
      hits.set(key, h);
    }
    const budget = key.endsWith(":unknown") ? Math.max(1, Math.floor(opts.perIpPerMinute / 10)) : opts.perIpPerMinute;
    if (h.used + weight > budget) throw new RpcRateLimited("ip", Math.max(1, Math.ceil((h.start + 60_000 - t) / 1000)));
    h.used += weight;
    global.used += weight;
  };
}

export type RpcProxyOptions = {
  /** Read lazily so a test (or a config reload) can change it. */
  upstreamUrl: () => string;
  /** Configured secrets (an API key) that must be scrubbed from anything relayed, besides what the URL itself reveals. */
  secrets?: () => string[];
  fetch?: typeof fetch;
  maxBatch?: number;
  maxResponseBytes?: number;
  timeoutMs?: number;
};

export function createRpcProxy(options: RpcProxyOptions) {
  const doFetch = options.fetch ?? fetch;
  const maxBatch = options.maxBatch ?? 10;
  const maxResponse = options.maxResponseBytes ?? 8 * 1024 * 1024;
  const timeoutMs = options.timeoutMs ?? 15_000;

  /**
   * `admit` is charged the work of the whole request before anything is sent upstream, and may throw
   * {@link RpcRateLimited}. A body that does not parse is charged 1.
   */
  async function handle(rawBody: string, admit: (weight: number) => void): Promise<ProxyResult> {
    const limited = (e: RpcRateLimited): ProxyResult => ({
      status: 429,
      body: rpcError(null, -32005, `rate limit exceeded (${e.scope}); retry shortly`),
      retryAfter: String(e.retryAfterSeconds),
    });
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      try {
        admit(1);
      } catch (e) {
        if (e instanceof RpcRateLimited) return limited(e);
        throw e;
      }
      return { status: 400, body: rpcError(null, -32700, "parse error") };
    }

    let payload: Call | Call[];
    try {
      if (Array.isArray(parsed)) {
        if (parsed.length === 0 || parsed.length > maxBatch) throw new Invalid(`batch must hold 1 to ${maxBatch} requests`);
        payload = parsed.map(validate);
      } else {
        payload = validate(parsed);
      }
    } catch (e) {
      if (!(e instanceof Invalid)) throw e;
      // Rejected requests still cost something: the body was read and parsed.
      try {
        admit(Array.isArray(parsed) ? Math.min(Math.max(parsed.length, 1), maxBatch) : 1);
      } catch (limit) {
        if (limit instanceof RpcRateLimited) return limited(limit);
        throw limit;
      }
      return { status: 400, body: rpcError(e.id, -32600, e.message) };
    }

    const calls = Array.isArray(payload) ? payload : [payload];
    try {
      admit(calls.reduce((n, c) => n + c.weight, 0));
    } catch (e) {
      if (e instanceof RpcRateLimited) return limited(e);
      throw e;
    }

    const upstream = options.upstreamUrl();
    const secrets = secretsFor(upstream, options.secrets?.() ?? []);
    const scrub = (text: string) => secrets.reduce((t, s) => t.split(s).join("<redacted>"), text);
    const fail = (status: number, message: string, retryAfter?: string): ProxyResult => ({
      status,
      body: rpcError(null, -32000, message),
      ...(retryAfter ? { retryAfter } : {}),
    });
    // What goes upstream is rebuilt from validated fields only.
    const wire = calls.map(({ jsonrpc, id, method, params }) => ({ jsonrpc, id, method, params }));
    const body = JSON.stringify(Array.isArray(payload) ? wire : wire[0]);

    try {
      const res = await doFetch(upstream, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body,
        redirect: "error",
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status === 429) {
        await res.body?.cancel().catch(() => {});
        const wait = res.headers.get("retry-after") ?? "";
        return fail(429, "upstream rate limit, retry shortly", /^\d{1,4}$/.test(wait) ? wait : undefined);
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        return fail(502, "upstream RPC unavailable");
      }
      return { status: 200, body: scrub(await readCapped(res, maxResponse)) };
    } catch (e) {
      if (e instanceof UpstreamTooLarge) return fail(502, "upstream response too large");
      return fail(502, "upstream RPC unavailable");
    }
  }

  return { handle };
}

export type RpcProxy = ReturnType<typeof createRpcProxy>;
