const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function churn(k) { const o = []; for (let i = 0; i < k; i++) o.push({ i, s: "x".repeat(32) }); return o.length; }
async function bg() { await sleep(5); churn(200); }
async function inner(id) { await sleep(id % 3); churn(100); return "i" + id; }
async function handler(id) { bg(); const a = await inner(id); const b = await inner(id + 10); return a + "/" + b; }
Promise.all([handler(1), handler(2), handler(3)]).then((r) => console.log("s5 ok", r.length));
