// Mixed workload closer to real app code than a tight numeric loop: object
// construction, property access, string building, array methods, JSON. A JIT's
// advantage is far smaller here than on `arith.js`, so the ratio from this
// bench is the honest one to quote for app-shaped code.
const N = 200000;
const users = [];
for (let i = 0; i < N; i++) {
  users.push({ id: i, name: "user" + i, email: "u" + i + "@example.com", tags: ["a", "b"] });
}
let total = 0;
for (let i = 0; i < users.length; i++) {
  const u = users[i];
  if (u.name.indexOf("9") >= 0) total = total + u.id;
}
const picked = users.filter(u => u.id % 3 === 0).map(u => u.name.toUpperCase());
const s = JSON.stringify(users.slice(0, 200));
const back = JSON.parse(s);
console.log(total, picked.length, back.length, s.length);
