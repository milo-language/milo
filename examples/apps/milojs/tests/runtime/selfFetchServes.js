// Regression guard for the tahoeroads cold-fetch hang (fixed in 79e39a5).
// Fully self-contained — no external network: milojs serves an HTTP server and
// then fetches from ITSELF. The request handler's activation parks on that
// fetch; before the fix the event loop re-entered a BLOCKING accept() and
// starved the loop, so the self-fetch response sat unserviced forever and
// "fetched" never printed. Also exercises the fd-close path (the self-fetch
// client drains the response to EOF). Must complete, in order.
const http = require("http");
const server = http.createServer((req, res) => {
  console.log("SERVED", req.url);
  res.writeHead(200);
  res.end("ok");
});
server.listen(47021, () => {
  console.log("up");
  main();
});
async function main() {
  const r = await fetch("http://127.0.0.1:47021/one");
  console.log("fetched", r.status, await r.text());
  process.exit(0);
}
