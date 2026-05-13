import { createServer } from "node:http";

function fibonacci(n) {
  if (n <= 1) return n;
  let a = 0, b = 1;
  for (let i = 2; i <= n; i++) [a, b] = [b, a + b];
  return b;
}

function isPrime(n) {
  if (n < 2) return false;
  if (n < 4) return true;
  if (n % 2 === 0) return false;
  for (let i = 3; i * i <= n; i += 2) {
    if (n % i === 0) return false;
  }
  return true;
}

function collatzSeq(start) {
  let x = start, steps = 0;
  const seq = [x];
  while (x !== 1 && steps < 500) {
    x = x % 2 === 0 ? x / 2 : x * 3 + 1;
    seq.push(x);
    steps++;
  }
  return { start, steps, sequence: seq.join(" > ") };
}

function fizzbuzzText(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) {
    if (i % 15 === 0) lines.push("FizzBuzz");
    else if (i % 3 === 0) lines.push("Fizz");
    else if (i % 5 === 0) lines.push("Buzz");
    else lines.push(String(i));
  }
  return lines.join("\n");
}

const HTML = `<!DOCTYPE html><html><body><h1>node benchmark server</h1></body></html>`;

function handler(req, res) {
  const url = req.url;

  if (url === "/hello") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end("Hello from Node!");
  } else if (url === "/json") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ language: "milo", backend: "llvm", memory_safe: true }));
  } else if (url === "/") {
    res.writeHead(200, { "Content-Type": "text/html" });
    res.end(HTML);
  } else if (url.startsWith("/fib/")) {
    const n = parseInt(url.slice(5));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ n, result: fibonacci(n) }));
  } else if (url.startsWith("/prime/")) {
    const n = parseInt(url.slice(7));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ n, is_prime: isPrime(n) }));
  } else if (url.startsWith("/collatz/")) {
    const n = parseInt(url.slice(9));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(collatzSeq(n)));
  } else if (url.startsWith("/fizzbuzz/")) {
    const n = parseInt(url.slice(10));
    res.writeHead(200, { "Content-Type": "text/plain" });
    res.end(fizzbuzzText(n));
  } else {
    res.writeHead(404);
    res.end("404 Not Found");
  }
}

const port = parseInt(process.argv[2] || "8081");
createServer(handler).listen(port, "127.0.0.1", () => {
  console.log(`node listening on :${port}`);
});
