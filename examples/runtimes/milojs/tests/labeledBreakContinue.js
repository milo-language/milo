// continue to an outer for, break to an outer for
let out1 = [];
outer: for (let i = 0; i < 3; i++) {
  for (let j = 0; j < 3; j++) {
    if (j === 1) continue outer;
    if (i === 2) break outer;
    out1.push(i + "," + j);
  }
}
console.log(out1.join(" "));

// labeled while
let n = 0, hit = [];
loop: while (true) {
  n++;
  if (n > 5) break loop;
  if (n % 2 === 0) continue loop;
  hit.push(n);
}
console.log(hit.join(","), "n=" + n);

// labeled for-of, break out of nested from inner
const grid = [[1, 2], [3, 4], [5, 6]];
let found = null;
search: for (const row of grid) {
  for (const v of row) {
    if (v === 4) { found = v; break search; }
  }
}
console.log("found", found);

// labeled for-in
let keys = [];
scan: for (const k in { a: 1, b: 2, c: 3 }) {
  if (k === "b") continue scan;
  keys.push(k);
}
console.log(keys.join(","));

// break out of a labeled block (non-loop)
let steps = [];
block: {
  steps.push("A");
  if (steps.length === 1) break block;
  steps.push("B");
}
console.log(steps.join(","));

// unlabeled break inside switch inside labeled loop still breaks only the switch
let sw = [];
tag: for (let i = 0; i < 3; i++) {
  switch (i) {
    case 1: sw.push("one"); break;
    default: sw.push("d" + i);
  }
  if (i === 2) break tag;
}
console.log(sw.join(","));

// labeled break from inside a switch targets the loop
let sw2 = [];
esc: for (let i = 0; i < 5; i++) {
  switch (i) {
    case 2: break esc;
    default: sw2.push(i);
  }
}
console.log(sw2.join(","));

// do-while with labeled continue from nested loop
let dw = [];
d: do {
  for (let k = 0; k < 3; k++) {
    if (k === 1) continue d;
    dw.push(k);
  }
} while (dw.length < 2);
console.log(dw.join(","));
