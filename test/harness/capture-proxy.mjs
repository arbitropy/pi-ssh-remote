// Transparent HTTP proxy that records every request body sent to the model endpoint.
// Usage: node capture-proxy.mjs <listenPort> <upstreamBaseUrl> <outDir>
// Point the harness provider's baseUrl at http://127.0.0.1:<listenPort>/v1 to inspect what pi sends
// (system prompt, tools, and the request-time messages that extension `context` handlers produce).
import http from "node:http";
import https from "node:https";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [port, upstream, outDir] = process.argv.slice(2);
if (!port || !upstream || !outDir) {
  console.error("usage: capture-proxy.mjs <listenPort> <upstreamBaseUrl> <outDir>");
  process.exit(2);
}
mkdirSync(outDir, { recursive: true });
const base = new URL(upstream);
let count = 0;

http.createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    const body = Buffer.concat(chunks);
    if (body.length) writeFileSync(join(outDir, `${String(++count).padStart(3, "0")}.json`), body);
    // Join the request path onto the upstream base path ("/v1" + "/chat/completions" when baseUrl ends in /v1).
    const suffix = req.url.startsWith(base.pathname) ? req.url.slice(base.pathname.length) : req.url;
    const target = new URL(base.pathname.replace(/\/$/, "") + suffix, base);
    const client = target.protocol === "https:" ? https : http;
    const upstreamReq = client.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (upstreamRes) => {
      res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    });
    upstreamReq.on("error", (error) => { res.writeHead(502); res.end(String(error)); });
    upstreamReq.end(body);
  });
}).listen(Number(port), "127.0.0.1", () => console.error(`capture-proxy :${port} -> ${upstream} (${outDir})`));
