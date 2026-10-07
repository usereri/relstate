// Contract 2 server stub (workstream C owns the real implementation).
import { createServer } from "node:http";
import { SPONSOR_ALLOWLIST, type SponsorRequest } from "./contracts";

const PORT = Number(process.env.PORT ?? 8787);

createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.writeHead(204).end();
  if (req.method === "POST" && req.url === "/api/sponsor") {
    let body = "";
    for await (const c of req) body += c;
    const { txBase64 } = JSON.parse(body) as SponsorRequest;
    // TODO(C): decode, check every program id is in SPONSOR_ALLOWLIST, rate-limit per wallet, add fee-payer signature, send.
    void SPONSOR_ALLOWLIST;
    void txBase64;
    return res.writeHead(501, { "content-type": "application/json" }).end(JSON.stringify({ error: "sponsor not implemented" }));
  }
  res.writeHead(404).end();
}).listen(PORT, () => console.log(`backend on :${PORT}`));
