// Spike: can our MoneyGram sandbox credentials create a Ramps session, and what does the widget need?
// Run: node --env-file=<path to .env> spikes/moneygram/session.mjs
// Prints statuses and response SHAPES only; token and key values are redacted.
const SK = process.env.MONEYGRAM_PRIVATE_KEY;
const PK = process.env.MONEYGRAM_PUBLIC_KEY;
const URL_ = process.env.MONEYGRAM_SESSIONS_URL ?? "https://playground.xramps.moneygram.com/api/v1/sessions";
const shape = (k) => (k ? `${k.slice(0, k.indexOf("_", k.indexOf("_") + 1) + 1)}… (${k.length} chars)` : "MISSING");
console.log("secret key:", shape(SK), "| public key:", shape(PK));
const red = (v) => (typeof v === "string" && v.length > 24 ? v.slice(0, 6) + "…<redacted>" : v);
async function call(label, headers) {
  const res = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text.slice(0, 200); }
  console.log(`\n${label}: HTTP ${res.status}`);
  console.log(typeof body === "object" ? Object.fromEntries(Object.entries(body).map(([k, v]) => [k, red(v)])) : body);
  return { res, body };
}
const a = await call("x-api-key = private key", { "x-api-key": SK });
if (!a.res.ok && PK) await call("x-api-key = public key", { "x-api-key": PK });
if (a.res.ok) {
  const u = new URL(a.body.widgetUrl);
  console.log("\nwidget origin:", u.origin, "| path:", u.pathname, "| query keys:", [...u.searchParams.keys()]);
  const sdk = await fetch(u.origin + "/sdk/index.global.js");
  console.log("sdk script:", sdk.status, sdk.headers.get("content-type"), (await sdk.text()).length, "bytes");
}
