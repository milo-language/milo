const WARMUP = 50;
const REQUESTS = 2000;

const endpoints = [
  { label: "plain text",    path: "/hello" },
  { label: "json",          path: "/json" },
  { label: "fib(10)",       path: "/fib/10" },
  { label: "fib(30)",       path: "/fib/30" },
  { label: "prime(97)",     path: "/prime/97" },
  { label: "prime(999983)", path: "/prime/999983" },
  { label: "collatz(27)",   path: "/collatz/27" },
  { label: "fizzbuzz(100)", path: "/fizzbuzz/100" },
  { label: "html (index)",  path: "/" },
];

interface Result {
  label: string;
  rps: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
}

async function bench(base: string, label: string, path: string): Promise<Result> {
  const url = base + path;

  for (let i = 0; i < WARMUP; i++) {
    await fetch(url);
  }

  const latencies: number[] = [];
  const start = performance.now();

  for (let i = 0; i < REQUESTS; i++) {
    const t0 = performance.now();
    const res = await fetch(url);
    await res.text();
    latencies.push(performance.now() - t0);
  }

  const elapsed = performance.now() - start;
  latencies.sort((a, b) => a - b);

  return {
    label,
    rps: (REQUESTS / elapsed) * 1000,
    avg: latencies.reduce((a, b) => a + b, 0) / latencies.length,
    p50: latencies[Math.floor(latencies.length * 0.5)],
    p95: latencies[Math.floor(latencies.length * 0.95)],
    p99: latencies[Math.floor(latencies.length * 0.99)],
  };
}

function fmtRow(label: string, rps: number, avg: number, p50: number, p95: number, p99: number) {
  return (
    `${label.padEnd(18)} ${rps.toFixed(0).padStart(7)} req/s  ` +
    `avg ${avg.toFixed(2).padStart(6)}ms  ` +
    `p50 ${p50.toFixed(2).padStart(6)}ms  ` +
    `p95 ${p95.toFixed(2).padStart(6)}ms  ` +
    `p99 ${p99.toFixed(2).padStart(6)}ms`
  );
}

const servers: { name: string; port: number }[] = [
  { name: "milo", port: 8080 },
  { name: "node", port: 8081 },
];

// verify servers are up
for (const s of servers) {
  try {
    await fetch(`http://127.0.0.1:${s.port}/hello`);
  } catch {
    console.error(`${s.name} server not running on :${s.port}`);
    process.exit(1);
  }
}

const allResults: Record<string, Result[]> = {};

for (const s of servers) {
  const base = `http://127.0.0.1:${s.port}`;
  allResults[s.name] = [];
  for (const ep of endpoints) {
    allResults[s.name].push(await bench(base, ep.label, ep.path));
  }
}

// print per-server tables
const header =
  `${"endpoint".padEnd(18)} ${"req/s".padStart(7)}       ` +
  `${"avg".padStart(9)}     ${"p50".padStart(9)}     ${"p95".padStart(9)}     ${"p99".padStart(9)}`;
const sep = "─".repeat(90);

for (const s of servers) {
  console.log(`\n=== ${s.name} (${REQUESTS} sequential reqs, ${WARMUP} warmup) ===\n`);
  console.log(header);
  console.log(sep);
  for (const r of allResults[s.name]) {
    console.log(fmtRow(r.label, r.rps, r.avg, r.p50, r.p95, r.p99));
  }
}

// comparison table
console.log(`\n=== comparison (milo vs node) ===\n`);
console.log(
  `${"endpoint".padEnd(18)} ${"milo req/s".padStart(12)} ${"node req/s".padStart(12)}  ${"ratio".padStart(7)}`
);
console.log("─".repeat(55));

for (let i = 0; i < endpoints.length; i++) {
  const m = allResults["milo"][i];
  const n = allResults["node"][i];
  const ratio = m.rps / n.rps;
  const marker = ratio >= 1 ? "✓" : " ";
  console.log(
    `${m.label.padEnd(18)} ${m.rps.toFixed(0).padStart(12)} ${n.rps.toFixed(0).padStart(12)}  ${ratio.toFixed(2).padStart(6)}x ${marker}`
  );
}

console.log("\ndone.");
