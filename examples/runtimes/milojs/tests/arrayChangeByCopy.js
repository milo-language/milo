const a = [1, 2, 3];
console.log(a.with(0, 9).join(","), a.join(","));
console.log(a.with(-1, 9).join(","));
try { a.with(5, 0); } catch (e) { console.log("with range:", e.name); }
console.log(a.toReversed().join(","), a.join(","));
const b = [3, 1, 2];
console.log(b.toSorted().join(","), b.join(","));
console.log(b.toSorted((x, y) => y - x).join(","));
console.log(a.toSpliced(1, 1).join(","));
console.log(a.toSpliced(1, 0, 7, 8).join(","));
console.log(a.toSpliced(-2, 1).join(","));
console.log([].toSpliced(0, 0, 1).join(","));
console.log(a.toSpliced(1).join("|"), a.join(","));
