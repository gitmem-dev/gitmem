/**
 * Preload for tests/e2e/blank-supabase.mjs (loaded via NODE_OPTIONS=--import).
 *
 * Wraps globalThis.fetch in the gitmem server process and appends one JSON line
 * per request to $GITMEM_NETLOG: method, host, path, status, and the size of the
 * response body as the process received it (decoded — an upper bound on wire bytes
 * when the response was gzip'd). Request bodies are never logged; auth headers
 * are never logged.
 */
import { appendFileSync } from "node:fs";

const LOG = process.env.GITMEM_NETLOG;
const realFetch = globalThis.fetch;

if (LOG && realFetch) {
  globalThis.fetch = async function netlogFetch(input, init) {
    const url = new URL(typeof input === "string" ? input : input.url ?? String(input));
    const method = (init?.method || (typeof input === "object" && input.method) || "GET").toUpperCase();
    const started = Date.now();
    let response;
    try {
      response = await realFetch(input, init);
    } catch (err) {
      appendFileSync(LOG, JSON.stringify({ t: started, method, host: url.host, path: url.pathname, status: 0, bytes: 0, error: String(err).slice(0, 200) }) + "\n");
      throw err;
    }
    const contentLength = response.headers.get("content-length");
    const encoding = response.headers.get("content-encoding");
    response
      .clone()
      .arrayBuffer()
      .then((buf) => {
        appendFileSync(LOG, JSON.stringify({
          t: started, ms: Date.now() - started, method, host: url.host, path: url.pathname,
          query: url.search.slice(0, 160), status: response.status, bytes: buf.byteLength,
          content_length: contentLength ? Number(contentLength) : null, encoding,
        }) + "\n");
      })
      .catch(() => {});
    return response;
  };
}
