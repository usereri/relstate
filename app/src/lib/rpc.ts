// Rate-limit handling for reads. The confidential-transfer proof plan is several transactions
// and a handful of account reads back to back, which is exactly what a public RPC answers with
// 429 (see the Phase 0 spike). Helius is the intended endpoint — set VITE_RPC — but a retrying
// transport is what makes either endpoint survive a demo.
//
// Only 429 is retried. Every other response, including other errors, is passed through
// unchanged, so nothing else about the app's RPC behaviour moves.

const MAX_ATTEMPTS = 6;
const BASE_DELAY_MS = 400;
const MAX_DELAY_MS = 8_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exponential backoff with jitter, overridden by the server's `Retry-After` when it sends one. */
const backoffMs = (attempt: number, retryAfter?: string | null) => {
  const header = retryAfter && (/^\d+$/.test(retryAfter.trim()) ? Number(retryAfter) * 1000 : Date.parse(retryAfter) - Date.now());
  if (typeof header === "number" && Number.isFinite(header) && header > 0) return Math.min(header, MAX_DELAY_MS);
  return Math.min(BASE_DELAY_MS * 2 ** attempt, MAX_DELAY_MS) * (0.5 + Math.random() / 2);
};

/**
 * A `fetch` that retries 429 with backoff. Passed to web3.js's `Connection`, which otherwise
 * surfaces the 429 straight to the caller as a failed read.
 */
export const retryingFetch: typeof fetch = async (input, init) => {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(input, init);
    if (res.status !== 429 || attempt >= MAX_ATTEMPTS - 1) return res;
    await sleep(backoffMs(attempt, res.headers.get("retry-after")));
  }
};

/** The same policy for a `@solana/kit` RPC transport, which reports a 429 as a thrown error. */
export function retryOn429<T extends (...args: never[]) => Promise<unknown>>(transport: T): T {
  const is429 = (e: unknown) => {
    const ctx = (e as { context?: { statusCode?: number } })?.context;
    return ctx?.statusCode === 429 || /\b429\b|too many requests/i.test(String((e as Error)?.message ?? ""));
  };
  return (async (...args: Parameters<T>) => {
    for (let attempt = 0; ; attempt++) {
      try {
        return await transport(...args);
      } catch (e) {
        if (!is429(e) || attempt >= MAX_ATTEMPTS - 1) throw e;
        await sleep(backoffMs(attempt));
      }
    }
  }) as T;
}
