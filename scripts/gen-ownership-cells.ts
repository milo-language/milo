#!/usr/bin/env bun
// The ownership table (docs/plans/ownership-table.md, step 1): one program per cell
// (semantic op x backend representation x type class), each run through the checker and the
// MLIR-vs-interpreter comparison of scripts/mlir-same.ts (stdout, exit code, live heap blocks).
// Measurement only: it classifies every cell as covered, refused (MlirUnsupported), WRONG
// (differs from the interpreter: a miscompile), no oracle, or rejected by the checker.
//
//   bun scripts/gen-ownership-cells.ts [--filter regex] [--jobs 6] [--no-run]
//
// Programs go to out/gen-own/ (untracked); checker-rejected ones to out/gen-own/rejected/.
// Output: a markdown table on stdout, out/ownership-cells.json, and a summary line.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dir, "..");
const OUT = join(ROOT, "out");
const DIR = join(OUT, "gen-own");
const argv = process.argv.slice(2);
const opt = (n: string) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : undefined; };
const JOBS = Number(opt("--jobs") ?? 6);
const filterArg = opt("--filter");
const filter = filterArg?.startsWith("@") ? readFileSync(filterArg.slice(1), "utf-8").trim() : filterArg; // @file: regex from a file

// ---- type classes (Axis 2's "type class"). Each supplies T, mk(n): T (fresh owned value), sh(x: &T).
type TC = { id: string; copy: boolean; str?: boolean; decl: string; T: string; kind: "scalar" | "str" | "vec" | "struct" | "enum" | "heap" | "closure" | "big" };
const BIGF = Array.from({ length: 16 }, (_, i) => `a${i}: i64`).join(", ");
const BIGI = Array.from({ length: 16 }, (_, i) => `a${i}: n + ${i}`).join(", ");
const TCS: TC[] = [
  { id: "scalar", copy: true, kind: "scalar", T: "i64", decl: `fn mk(n: i64): i64 { return n * 10 + 7 }\nfn sh(x: &i64) { print(x) }\n` },
  { id: "string", copy: false, str: true, kind: "str", T: "string", decl: `fn mk(n: i64): string { return "s".repeat(3) + n.toString() }\nfn sh(x: &string) { print(x) }\n` },
  { id: "vecstr", copy: false, kind: "vec", T: "Vec<string>", decl: `fn mk(n: i64): Vec<string> {\n    var v: Vec<string> = Vec.new()\n    v.push("a".repeat(2) + n.toString())\n    v.push("b".repeat(2) + n.toString())\n    return v\n}\nfn sh(x: &Vec<string>) {\n    print(x.len.toString())\n    print(x[0])\n    print(x[1])\n}\n` },
  { id: "struct", copy: false, kind: "struct", T: "S", decl: `@derive(Clone)\nstruct S { name: string, n: i64, tags: Vec<string> }\nfn mk(n: i64): S {\n    var t: Vec<string> = Vec.new()\n    t.push("t".repeat(2) + n.toString())\n    return S { name: "n".repeat(2) + n.toString(), n: n, tags: t }\n}\nfn sh(x: &S) {\n    print(x.name)\n    print(x.n)\n    print(x.tags[0])\n}\n` },
  { id: "enum", copy: false, kind: "enum", T: "E", decl: `@derive(Clone)\nenum E { A(string), B(i64), C }\nfn mk(n: i64): E { return E.A("e".repeat(2) + n.toString()) }\nfn sh(x: &E) {\n    match x {\n        E.A(s) => { print(s) }\n        E.B(k) => { print(k) }\n        E.C => { print("c") }\n    }\n}\n` },
  { id: "heap", copy: false, kind: "heap", T: "Heap<S>", decl: `struct S { name: string, n: i64, tags: Vec<string> }\nfn mk(n: i64): Heap<S> {\n    var t: Vec<string> = Vec.new()\n    t.push("t".repeat(2) + n.toString())\n    return Heap(S { name: "h".repeat(2) + n.toString(), n: n, tags: t })\n}\nfn sh(x: &Heap<S>) {\n    print((*x).name)\n    print((*x).tags[0])\n}\n` },
  { id: "closure", copy: false, kind: "closure", T: "move () => string", decl: `fn mk(n: i64): move () => string {\n    let s = "c".repeat(3) + n.toString()\n    return move (): string => s\n}\nfn sh(x: &move () => string) { print(x()) }\n` },
  { id: "big", copy: false, kind: "big", T: "Big", decl: `@derive(Clone)\nstruct Big { ${BIGF}, name: string }\nfn mk(n: i64): Big { return Big { ${BIGI}, name: "g".repeat(2) + n.toString() } }\nfn sh(x: &Big) {\n    print(x.name)\n    print(x.a15)\n}\n` },
];
const cloneable = (t: TC) => ["struct", "enum", "big", "scalar", "str", "vec"].includes(t.kind);

// ---- cells. `body` is the text of main; `extra` extra top-level decls. `exp` = expected checker verdict
// (default accept); a rejection must contain the given substring.
type Cell = { op: string; repr: string; tc: TC; extra: string; body: string; exp?: string };
const cells: Cell[] = [];
type Tmpl = { op: string; repr: string; when?: (t: TC) => boolean; extra?: (t: TC) => string; body: (t: TC) => string; exp?: (t: TC) => string | undefined };
const T_: Tmpl[] = [];
const add = (t: Tmpl) => T_.push(t);
const movedRej = (t: TC) => (t.copy || t.str ? undefined : "moved");

// -- read Copy / read owned (move)
add({ op: "read", repr: "ssa-let", body: t => `let a = mk(1)\n    let b = a\n    sh(b)\n    ${t.copy ? "sh(a)" : ""}` });
add({ op: "read", repr: "var-slot", body: t => `var a = mk(1)\n    a = mk(2)\n    var b = a\n    b = mk(3)\n    sh(b)\n    ${t.copy ? "sh(a)" : ""}` });
add({ op: "read", repr: "use-after-move", body: () => `let a = mk(1)\n    let b = a\n    sh(b)\n    sh(a)`, exp: movedRej });
add({ op: "read", repr: "move-out-of-ref-param", extra: t => `fn bad(x: &${t.T}): ${t.T} { return x }\n`, body: () => `let a = mk(1)\n    let b = bad(a)\n    sh(b)\n    sh(a)`, exp: t => (t.copy || t.str ? undefined : "move") });
// -- field move
add({ op: "field-move", repr: "ssa-struct", extra: t => `struct W { p: ${t.T}, q: ${t.T} }\n`, body: () => `let w = W { p: mk(1), q: mk(2) }\n    let a = w.p\n    sh(a)\n    sh(w.q)` });
add({ op: "field-move", repr: "var-struct", extra: t => `struct W { p: ${t.T}, q: ${t.T} }\n`, body: () => `var w = W { p: mk(1), q: mk(2) }\n    let a = w.p\n    sh(a)\n    sh(w.q)\n    w.p = mk(3)\n    sh(w.p)` });
add({ op: "field-move", repr: "use-moved-field", extra: t => `struct W { p: ${t.T}, q: ${t.T} }\n`, body: () => `let w = W { p: mk(1), q: mk(2) }\n    let a = w.p\n    sh(a)\n    sh(w.p)`, exp: movedRej });
// -- assign
add({ op: "assign", repr: "var-slot", body: () => `var a = mk(1)\n    a = mk(2)\n    sh(a)` });
add({ op: "assign", repr: "var-after-move", extra: t => `fn take(x: ${t.T}) { sh(x) }\n`, body: () => `var a = mk(1)\n    take(a)\n    a = mk(2)\n    sh(a)` });
add({ op: "assign", repr: "var-maybe-moved", extra: t => `fn take(x: ${t.T}) { sh(x) }\n`, body: () => `var a = mk(1)\n    let c = argc() > 0\n    if c { take(a) }\n    a = mk(2)\n    sh(a)` });
add({ op: "assign", repr: "through-mut-param", extra: t => `fn set(x: &mut ${t.T}) { x = mk(3) }\n`, body: () => `var a = mk(1)\n    set(&mut a)\n    sh(a)` });
add({ op: "assign", repr: "field", extra: t => `struct W { p: ${t.T}, q: i64 }\n`, body: () => `var w = W { p: mk(1), q: 0 }\n    w.p = mk(2)\n    sh(w.p)` });
add({ op: "assign", repr: "field-from-local", extra: t => `struct W { p: ${t.T}, q: i64 }\n`, body: () => `var w = W { p: mk(1), q: 0 }\n    let a = mk(2)\n    w.p = a\n    sh(w.p)` });
add({ op: "assign", repr: "vec-index", body: t => `var v: Vec<${t.T}> = Vec.new()\n    v.push(mk(1))\n    v.push(mk(2))\n    v[0] = mk(3)\n    sh(v[0])\n    sh(v[1])` });
// -- scope end
add({ op: "scope-end", repr: "two-locals", body: () => `if argc() == 0 {\n        let a = mk(1)\n        let b = mk(2)\n        sh(a)\n        sh(b)\n    }\n    print("end")` });
add({ op: "scope-end", repr: "cond-move-flag", extra: t => `fn take(x: ${t.T}) { sh(x) }\n`, body: () => `let a = mk(1)\n    let c = argc() > 0\n    if c { take(a) } else { sh(a) }\n    print("end")` });
add({ op: "scope-end", repr: "loop-body", body: () => `for i in 0..3 {\n        let a = mk(i)\n        sh(a)\n    }` });
add({ op: "scope-end", repr: "early-return", extra: _t => `fn f(c: bool): i64 {\n    let a = mk(1)\n    let b = mk(2)\n    if c { return 1 }\n    sh(a)\n    sh(b)\n    return 0\n}\n`, body: () => `print(f(argc() == 0))\n    print(f(argc() > 0))` });
add({ op: "scope-end", repr: "break-in-loop", body: () => `var i = 0\n    while true {\n        let a = mk(i)\n        sh(a)\n        i = i + 1\n        if i > 1 { break }\n    }` });
// -- temporary
add({ op: "temporary", repr: "arg-ref", body: () => `sh(mk(1))` });
add({ op: "temporary", repr: "arg-value", extra: t => `fn take(x: ${t.T}) { sh(x) }\n`, body: () => `take(mk(1))` });
add({ op: "temporary", repr: "discarded", body: () => `mk(1)\n    print("done")` });
add({ op: "temporary", repr: "field-read", extra: t => `struct W { p: ${t.T}, q: i64 }\nfn mkw(n: i64): W { return W { p: mk(n), q: n } }\n`, body: () => `print(mkw(1).q)\n    sh(mkw(2).p)` });
// -- call arg
add({ op: "call-arg", repr: "by-value-let", extra: t => `fn take(x: ${t.T}) { sh(x) }\n`, body: () => `let a = mk(1)\n    take(a)` });
add({ op: "call-arg", repr: "by-value-var", extra: t => `fn take(x: ${t.T}) { sh(x) }\n`, body: () => `var a = mk(1)\n    take(a)` });
add({ op: "call-arg", repr: "ref", extra: t => `fn rd(x: &${t.T}) { sh(x) }\n`, body: () => `let a = mk(1)\n    rd(a)\n    rd(a)\n    sh(a)` });
add({ op: "call-arg", repr: "mut-ref", extra: t => `fn md(x: &mut ${t.T}) { sh(x)\n    x = mk(5) }\n`, body: () => `var a = mk(1)\n    md(&mut a)\n    sh(a)` });
add({ op: "call-arg", repr: "ref-forward", extra: t => `fn rd(x: &${t.T}) { sh(x) }\nfn fw(x: &${t.T}) { rd(x)\n    rd(x) }\n`, body: () => `let a = mk(1)\n    fw(a)` });
add({ op: "call-arg", repr: "mut-forward", extra: t => `fn md(x: &mut ${t.T}) { x = mk(5) }\nfn fw(x: &mut ${t.T}) { md(&mut x)\n    sh(x) }\n`, body: () => `var a = mk(1)\n    fw(&mut a)` });
add({ op: "call-arg", repr: "two-moves", extra: t => `fn two(x: ${t.T}, y: ${t.T}) { sh(y)\n    sh(x) }\n`, body: () => `let a = mk(1)\n    let b = mk(2)\n    two(a, b)\n    two(mk(3), mk(4))` });
// -- return
add({ op: "return", repr: "local", extra: t => `fn f(): ${t.T} {\n    let a = mk(1)\n    return a\n}\n`, body: () => `let r = f()\n    sh(r)` });
add({ op: "return", repr: "param", extra: t => `fn f(x: ${t.T}): ${t.T} { return x }\n`, body: () => `let r = f(mk(1))\n    sh(r)` });
add({ op: "return", repr: "branch-two-locals", extra: t => `fn f(c: bool): ${t.T} {\n    let a = mk(1)\n    let b = mk(2)\n    if c { return a }\n    return b\n}\n`, body: () => `sh(f(argc() == 0))\n    sh(f(argc() > 0))` });
add({ op: "return", repr: "temp", extra: t => `fn f(): ${t.T} { return mk(1) }\n`, body: () => `sh(f())` });
add({ op: "return", repr: "field-of-local", extra: t => `struct W { p: ${t.T}, q: ${t.T} }\nfn f(): ${t.T} {\n    let w = W { p: mk(1), q: mk(2) }\n    return w.p\n}\n`, body: () => `sh(f())` });
add({ op: "return", repr: "var-slot", extra: t => `fn f(): ${t.T} {\n    var a = mk(1)\n    a = mk(2)\n    return a\n}\n`, body: () => `sh(f())` });
// -- store
add({ op: "store", repr: "struct-field-temp", extra: t => `struct W { p: ${t.T}, q: i64 }\n`, body: () => `let w = W { p: mk(1), q: 2 }\n    sh(w.p)` });
add({ op: "store", repr: "struct-field-local", extra: t => `struct W { p: ${t.T}, q: i64 }\n`, body: () => `let a = mk(1)\n    let w = W { p: a, q: 2 }\n    sh(w.p)` });
add({ op: "store", repr: "vec-push-local", body: t => `var v: Vec<${t.T}> = Vec.new()\n    let a = mk(1)\n    v.push(a)\n    v.push(mk(2))\n    sh(v[0])\n    sh(v[1])\n    print(v.len.toString())` });
add({ op: "store", repr: "vec-pop", body: t => `var v: Vec<${t.T}> = Vec.new()\n    v.push(mk(1))\n    v.push(mk(2))\n    match v.pop() {\n        Some(x) => { sh(x) }\n        None => { print("none") }\n    }\n    print(v.len.toString())` });
add({ op: "store", repr: "vec-literal", body: t => `let v: Vec<${t.T}> = [mk(1), mk(2)]\n    sh(v[1])` });
add({ op: "store", repr: "heap-box", body: t => `let h: Heap<${t.T}> = Heap(mk(1))\n    sh(*h)` });
add({ op: "store", repr: "heap-deref-move", when: t => !t.copy, body: t => `let h: Heap<${t.T}> = Heap(mk(1))\n    let a = *h\n    sh(a)` });
add({ op: "store", repr: "option-some", body: t => `let o: Option<${t.T}> = Some(mk(1))\n    match o {\n        Some(x) => { sh(x) }\n        None => { print("none") }\n    }` });
add({ op: "store", repr: "hashmap-insert", body: t => `var m: HashMap<i64, ${t.T}> = HashMap.new()\n    m.insert(1, mk(1))\n    m.insert(1, mk(2))\n    m.insert(2, mk(3))\n    print(m.len.toString())\n    match m.get(1) {\n        Some(x) => { sh(x) }\n        None => { print("none") }\n    }` });
add({ op: "store", repr: "array-literal", body: _t => `let a = mk(1)\n    let arr = [a, mk(2)]\n    sh(arr[1])` });
add({ op: "store", repr: "nested-vec", body: t => `var v: Vec<Vec<${t.T}>> = Vec.new()\n    var w: Vec<${t.T}> = Vec.new()\n    w.push(mk(1))\n    v.push(w)\n    sh(v[0][0])` });
// -- fork
add({ op: "fork", repr: "if-temps", body: () => `let c = argc() > 0\n    let a = if c { mk(1) } else { mk(2) }\n    sh(a)` });
add({ op: "fork", repr: "if-locals", body: () => `let x = mk(1)\n    let y = mk(2)\n    let c = argc() > 0\n    let a = if c { x } else { y }\n    sh(a)` });
add({ op: "fork", repr: "match-int", body: () => `let k = argc()\n    let a = match k {\n        0 => mk(1),\n        _ => mk(2),\n    }\n    sh(a)` });
add({ op: "fork", repr: "if-let-option", body: t => `let o: Option<${t.T}> = Some(mk(1))\n    let a = match o {\n        Some(x) => x,\n        None => mk(2),\n    }\n    sh(a)` });
// -- match binding
add({ op: "match-binding", repr: "option-by-value", body: t => `let o: Option<${t.T}> = Some(mk(1))\n    match o {\n        Some(x) => { sh(x) }\n        None => { print("none") }\n    }` });
add({ op: "match-binding", repr: "option-on-ref", extra: t => `fn m(o: &Option<${t.T}>) {\n    match o {\n        Some(x) => { sh(x) }\n        None => { print("none") }\n    }\n}\n`, body: t => `let o: Option<${t.T}> = Some(mk(1))\n    m(o)\n    m(o)` });
add({ op: "match-binding", repr: "option-on-mutref", extra: t => `fn m(o: &mut Option<${t.T}>) {\n    match o {\n        Some(x) => { sh(x) }\n        None => { print("none") }\n    }\n}\n`, body: t => `var o: Option<${t.T}> = Some(mk(1))\n    m(&mut o)` });
add({ op: "match-binding", repr: "option-move-out-of-ref", extra: t => `fn m(o: &Option<${t.T}>): ${t.T} {\n    match o {\n        Some(x) => { return x }\n        None => { return mk(0) }\n    }\n}\n`, body: () => `let o = Some(mk(1))\n    sh(m(o))`, exp: t => (t.copy || t.str ? undefined : "move") });
add({ op: "match-binding", repr: "if-let", body: t => `let o: Option<${t.T}> = Some(mk(1))\n    if let Some(x) = o {\n        sh(x)\n    }\n    print("end")` });
add({ op: "match-binding", repr: "while-let-pop", body: t => `var v: Vec<${t.T}> = Vec.new()\n    v.push(mk(1))\n    v.push(mk(2))\n    while let Some(x) = v.pop() {\n        sh(x)\n    }` });
add({ op: "match-binding", repr: "enum-by-value", when: t => t.kind === "enum", body: () => `let e = mk(1)\n    match e {\n        E.A(s) => { print(s) }\n        E.B(k) => { print(k) }\n        E.C => { print("c") }\n    }` });
add({ op: "match-binding", repr: "enum-payload-escapes", when: t => t.kind === "enum", extra: () => `fn f(e: E): string {\n    match e {\n        E.A(s) => { return s }\n        _ => { return "none" }\n    }\n}\n`, body: () => `print(f(mk(1)))` });
add({ op: "match-binding", repr: "enum-on-mutref", when: t => t.kind === "enum", extra: () => `fn g(e: &mut E) {\n    match e {\n        E.A(s) => { s = s + "!" }\n        _ => {}\n    }\n}\n`, body: () => `var e = mk(1)\n    g(&mut e)\n    sh(e)` });
add({ op: "match-binding", repr: "struct-destructure", when: t => t.kind === "struct", body: () => `let s = mk(1)\n    let { name, n, tags } = s\n    print(name)\n    print(n)\n    print(tags.len.toString())` });
// -- closure capture
add({ op: "capture", repr: "by-ref-lent", extra: _t => `fn call(f: () => i64): i64 { return f() }\n`, body: () => `let a = mk(1)\n    let r = call((): i64 => {\n        sh(a)\n        return 1\n    })\n    print(r)\n    sh(a)` });
add({ op: "capture", repr: "by-ref-var", extra: () => `fn call(f: () => i64): i64 { return f() }\n`, body: () => `var a = mk(1)\n    let r = call((): i64 => {\n        sh(a)\n        return 1\n    })\n    print(r)\n    a = mk(2)\n    sh(a)` });
add({ op: "capture", repr: "move-local", body: () => `let a = mk(1)\n    let f = move (): i64 => {\n        sh(a)\n        return 1\n    }\n    print(f())\n    print(f())` });
add({ op: "capture", repr: "move-then-use", body: () => `let a = mk(1)\n    let f = move (): i64 => {\n        sh(a)\n        return 1\n    }\n    print(f())\n    sh(a)`, exp: movedRej });
add({ op: "capture", repr: "move-returned", extra: _t => `fn mkf(): move () => i64 {\n    let a = mk(1)\n    return move (): i64 => {\n        sh(a)\n        return 1\n    }\n}\n`, body: () => `let f = mkf()\n    print(f())\n    print(f())` });
add({ op: "capture", repr: "loop-variable", extra: _t => `fn call(f: () => i64): i64 { return f() }\n`, body: t => `var v: Vec<${t.T}> = Vec.new()\n    v.push(mk(1))\n    v.push(mk(2))\n    for x in v {\n        call((): i64 => {\n            sh(x)\n            return 1\n        })\n    }` });
add({ op: "capture", repr: "move-in-loop", body: () => `for i in 0..2 {\n        let a = mk(i)\n        let f = move (): i64 => {\n            sh(a)\n            return i\n        }\n        print(f())\n    }` });
add({ op: "capture", repr: "closure-in-struct", extra: _t => `struct H { f: move () => i64 }\n`, body: () => `let a = mk(1)\n    let h = H { f: move (): i64 => {\n        sh(a)\n        return 1\n    } }\n    print(h.f())` });
add({ op: "capture", repr: "closure-passed-owned", extra: () => `fn run(f: move () => i64): i64 { return f() }\n`, body: () => `let a = mk(1)\n    print(run(move (): i64 => {\n        sh(a)\n        return 1\n    }))` });
add({ op: "capture", repr: "param-ref", extra: t => `fn call(f: () => i64): i64 { return f() }\nfn h(x: &${t.T}): i64 {\n    return call((): i64 => {\n        sh(x)\n        return 1\n    })\n}\n`, body: () => `let a = mk(1)\n    print(h(a))` });
add({ op: "capture", repr: "once-move-out", when: t => !t.copy, body: () => `let a = mk(1)\n    let f = move (): i64 => {\n        let b = a\n        sh(b)\n        return 1\n    }\n    print(f())` });
// -- for in
add({ op: "for-in", repr: "borrowed-vec", extra: t => `fn mkv(): Vec<${t.T}> {\n    var v: Vec<${t.T}> = Vec.new()\n    v.push(mk(1))\n    v.push(mk(2))\n    return v\n}\n`, body: () => `let v = mkv()\n    for x in v {\n        sh(x)\n    }\n    print(v.len.toString())` });
add({ op: "for-in", repr: "consumed-temp", extra: t => `fn mkv(): Vec<${t.T}> {\n    var v: Vec<${t.T}> = Vec.new()\n    v.push(mk(1))\n    v.push(mk(2))\n    return v\n}\n`, body: () => `for x in mkv() {\n        sh(x)\n    }` });
add({ op: "for-in", repr: "consumed-local-move", when: t => !t.copy, extra: t => `fn mkv(): Vec<${t.T}> {\n    var v: Vec<${t.T}> = Vec.new()\n    v.push(mk(1))\n    v.push(mk(2))\n    return v\n}\nfn eat(v: Vec<${t.T}>) {\n    for x in v {\n        let y = x\n        sh(y)\n    }\n}\n`, body: () => `eat(mkv())` });
add({ op: "for-in", repr: "mut-ref", extra: t => `fn mkv(): Vec<${t.T}> {\n    var v: Vec<${t.T}> = Vec.new()\n    v.push(mk(1))\n    v.push(mk(2))\n    return v\n}\n`, body: () => `var v = mkv()\n    for x in &mut v {\n        x = mk(9)\n    }\n    sh(v[0])\n    sh(v[1])` });
add({ op: "for-in", repr: "break-consumed", extra: t => `fn mkv(): Vec<${t.T}> {\n    var v: Vec<${t.T}> = Vec.new()\n    v.push(mk(1))\n    v.push(mk(2))\n    v.push(mk(3))\n    return v\n}\n`, body: () => `for x in mkv() {\n        sh(x)\n        break\n    }` });
// -- struct update
add({ op: "struct-update", repr: "base-local", when: t => t.kind === "struct", body: () => `let base = mk(1)\n    let s = S { n: 5, ..base }\n    sh(s)` });
add({ op: "struct-update", repr: "base-temp", when: t => t.kind === "struct", body: () => `let s = S { n: 5, ..mk(1) }\n    sh(s)` });
add({ op: "struct-update", repr: "override-owned", when: t => t.kind === "struct", body: () => `let base = mk(1)\n    let s = S { name: "zz".repeat(2), ..base }\n    sh(s)` });
add({ op: "struct-update", repr: "base-local-big", when: t => t.kind === "big", body: () => `let base = mk(1)\n    let s = Big { a0: 5, ..base }\n    sh(s)` });
add({ op: "struct-update", repr: "base-temp-big", when: t => t.kind === "big", body: () => `let s = Big { a0: 5, ..mk(1) }\n    sh(s)` });
// -- propagate
add({ op: "propagate", repr: "result-ok-err", extra: t => `fn f(ok: bool): Result<${t.T}, string> {\n    if !ok { return Result.Err("bad") }\n    return Result.Ok(mk(1))\n}\nfn g(ok: bool): Result<${t.T}, string> {\n    let v = f(ok)?\n    return Result.Ok(v)\n}\n`, body: _t => `match g(argc() == 0) {\n        Ok(v) => { sh(v) }\n        Err(e) => { print(e) }\n    }\n    match g(argc() > 0) {\n        Ok(v) => { sh(v) }\n        Err(e) => { print(e) }\n    }` });
add({ op: "propagate", repr: "with-live-local", extra: t => `fn f(ok: bool): Result<${t.T}, string> {\n    if !ok { return Result.Err("bad") }\n    return Result.Ok(mk(1))\n}\nfn g(ok: bool): Result<i64, string> {\n    let keep = mk(9)\n    let v = f(ok)?\n    sh(keep)\n    sh(v)\n    return Result.Ok(1)\n}\n`, body: () => `print(g(argc() == 0).isOk())\n    print(g(argc() > 0).isOk())` });
add({ op: "propagate", repr: "option", extra: t => `fn f(ok: bool): Option<${t.T}> {\n    if !ok { return None }\n    return Some(mk(1))\n}\nfn g(ok: bool): Option<${t.T}> {\n    let v = f(ok)?\n    return Some(v)\n}\n`, body: () => `match g(argc() == 0) {\n        Some(v) => { sh(v) }\n        None => { print("none") }\n    }\n    match g(argc() > 0) {\n        Some(v) => { sh(v) }\n        None => { print("none") }\n    }` });
add({ op: "propagate", repr: "combinator-map", extra: t => `fn f(ok: bool): Option<${t.T}> {\n    if !ok { return None }\n    return Some(mk(1))\n}\n`, body: () => `let n = f(argc() == 0).map((x: &%T%): i64 => 1).unwrapOr(0)\n    print(n)` });
// -- replace / swap
add({ op: "replace-swap", repr: "replace-var", body: () => `var a = mk(1)\n    let old = replace(a, mk(2))\n    sh(old)\n    sh(a)` });
add({ op: "replace-swap", repr: "swap-vars", body: () => `var a = mk(1)\n    var b = mk(2)\n    swap(a, b)\n    sh(a)\n    sh(b)` });
add({ op: "replace-swap", repr: "swap-vec-elems", body: t => `var v: Vec<${t.T}> = Vec.new()\n    v.push(mk(1))\n    v.push(mk(2))\n    swap(v[0], v[1])\n    sh(v[0])\n    sh(v[1])` });
add({ op: "replace-swap", repr: "replace-field", extra: t => `struct W { p: ${t.T}, q: i64 }\n`, body: () => `var w = W { p: mk(1), q: 0 }\n    let old = replace(w.p, mk(2))\n    sh(old)\n    sh(w.p)` });
add({ op: "replace-swap", repr: "replace-through-ref", extra: t => `fn take(x: &mut ${t.T}): ${t.T} { return replace(x, mk(7)) }\n`, body: () => `var a = mk(1)\n    let old = take(&mut a)\n    sh(old)\n    sh(a)` });
// -- clone
add({ op: "clone", repr: "let", when: cloneable, body: () => `let a = mk(1)\n    let b = a.clone()\n    sh(a)\n    sh(b)` });
add({ op: "clone", repr: "temp", when: cloneable, body: () => `let a = mk(1)\n    sh(a.clone())\n    sh(a)` });
add({ op: "clone", repr: "vec-of", when: cloneable, body: t => `var v: Vec<${t.T}> = Vec.new()\n    v.push(mk(1))\n    v.push(mk(2))\n    let w = v.clone()\n    sh(w[1])\n    sh(v[0])` });
add({ op: "clone", repr: "from-ref-param", when: cloneable, extra: t => `fn dup(x: &${t.T}): ${t.T} { return x.clone() }\n`, body: () => `let a = mk(1)\n    let b = dup(a)\n    sh(b)` });
// -- string copy (counted buffer)
add({ op: "string-copy", repr: "shared-then-write", when: t => t.kind === "str", body: () => `var a = mk(1)\n    let b = a\n    a.push(33)\n    sh(a)\n    sh(b)` });
add({ op: "string-copy", repr: "shared-into-struct", when: t => t.kind === "str", extra: () => `struct R { name: string }\n`, body: () => `var s = mk(1)\n    let r = R { name: s }\n    s.push(33)\n    sh(s)\n    print(r.name)` });
add({ op: "string-copy", repr: "shared-vec-elem", when: t => t.kind === "str", body: () => `var v: Vec<string> = Vec.new()\n    v.push(mk(1))\n    let a = v[0]\n    v[0] = mk(2)\n    sh(a)\n    sh(v[0])` });
add({ op: "string-copy", repr: "shared-closure-capture", when: t => t.kind === "str", body: () => `let a = mk(1)\n    let f = move (): i64 => {\n        sh(a)\n        return 1\n    }\n    sh(a)\n    print(f())` });
// -- 128+ place specific
add({ op: "big-place", repr: "field-of-big-in-vec", when: t => t.kind === "big", body: () => `var v: Vec<Big> = Vec.new()\n    v.push(mk(1))\n    v.push(mk(2))\n    let b = v.pop()\n    match b {\n        Some(x) => { sh(x) }\n        None => {}\n    }\n    sh(v[0])` });
add({ op: "big-place", repr: "big-in-enum", when: t => t.kind === "big", extra: () => `enum Q { Has(Big), Not }\n`, body: () => `let q = Q.Has(mk(1))\n    match q {\n        Q.Has(b) => { sh(b) }\n        Q.Not => { print("not") }\n    }` });
add({ op: "big-place", repr: "big-by-value-chain", when: t => t.kind === "big", extra: () => `fn a(x: Big): Big { return x }\nfn b(x: Big): Big { return a(x) }\n`, body: () => `sh(b(mk(1)))` });

for (const tm of T_) {
  for (const tc of TCS) {
    if (tm.when && !tm.when(tc)) continue;
    const sub = (s: string) => s.replace(/%T%/g, tc.T);
    cells.push({ op: tm.op, repr: tm.repr, tc, extra: sub(tm.extra?.(tc) ?? ""), body: sub(tm.body(tc)), exp: tm.exp?.(tc) });
  }
}

const name = (c: Cell) => `${c.op}-${c.repr}-${c.tc.id}`;
const program = (c: Cell) =>
  `// generated by scripts/gen-ownership-cells.ts: ${c.op} / ${c.repr} / ${c.tc.id}\nfrom "std/args" import { args }\nfn argc(): i64 { return args().len as i64 - 1 }\n${c.tc.decl}${c.extra}\npub fn main(): i32 {\n    ${c.body}\n    return 0\n}\n`;

// ---- run
const sel = cells.filter(c => !filter || new RegExp(filter).test(name(c)));
rmSync(DIR, { recursive: true, force: true });
mkdirSync(join(DIR, "rejected"), { recursive: true });
for (const c of sel) writeFileSync(join(DIR, `${name(c)}.milo`), program(c));

type Status = "covered" | "refused" | "WRONG" | "no oracle" | "rejected";
type Row = { op: string; repr: string; type: string; name: string; status: Status; message: string; expected?: string };
const rows = new Map<string, Row>();

async function pool<T>(items: T[], f: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: JOBS }, async () => { while (i < items.length) await f(items[i++]!); }));
}

// 1. checker
const accepted: Cell[] = [];
await pool(sel, async c => {
  const file = join(DIR, `${name(c)}.milo`);
  // A check killed under memory pressure prints nothing: retry rather than call it a rejection.
  let out = "";
  for (let attempt = 0; attempt < 4 && !out.trim(); attempt++) {
    const p = Bun.spawn(["bun", join(ROOT, "src", "main.ts"), "check", file, "--json"], { stdout: "pipe", stderr: "pipe" });
    out = await new Response(p.stdout).text();
    await p.exited;
  }
  let errs: string[] = [];
  try {
    const j = JSON.parse(out);
    const ds = Array.isArray(j) ? j : (j.diagnostics ?? j.errors ?? []);
    errs = ds.filter((d: any) => (d.severity ?? "error") === "error").map((d: any) => String(d.message ?? d.msg ?? JSON.stringify(d)));
  } catch { errs = [out.trim().split("\n")[0] ?? "check produced no json"]; }
  const base = { op: c.op, repr: c.repr, type: c.tc.id, name: name(c) };
  if (errs.length) {
    const first = errs[0]!.replace(/\s+/g, " ").slice(0, 160);
    const ok = c.exp !== undefined && first.includes(c.exp);
    rows.set(name(c), { ...base, status: "rejected", message: first, expected: c.exp === undefined ? "NO (cell should be accepted)" : ok ? "yes" : `NO (wanted '${c.exp}')` });
    rmSync(join(DIR, `${name(c)}.milo`));
    writeFileSync(join(DIR, "rejected", `${name(c)}.milo`), program(c));
  } else if (c.exp !== undefined) {
    rows.set(name(c), { ...base, status: "WRONG", message: `checker ACCEPTED a program that must be rejected ('${c.exp}')`, expected: "NO" });
    rmSync(join(DIR, `${name(c)}.milo`));
  } else accepted.push(c);
});
console.error(`check: ${sel.length} cells, ${accepted.length} accepted`);

// 2. compiled-vs-interpreter: one mlir-same run per op. The gate aborts a whole run when the
// machine is under memory pressure, so a batch that left no verdict file is retried.
if (!argv.includes("--no-run") && accepted.length) {
  type V = { name: string; verdict: string; detail?: string; refused: string[] };
  const verdicts: V[] = [];
  for (const op of [...new Set(accepted.map(c => c.op))]) {
    const jsonPath = join(OUT, `gen-own-verdicts-${op}.json`);
    for (let attempt = 1; attempt <= 4; attempt++) {
      if (argv.includes("--reuse") && existsSync(jsonPath)) { verdicts.push(...JSON.parse(readFileSync(jsonPath, "utf-8"))); break; }
      rmSync(jsonPath, { force: true });
      const args = ["scripts/mlir-same.ts", "--dir", DIR, "--owned", "--jobs", String(JOBS), "--json", jsonPath, "--filter", `^${op}-`];
      const p = Bun.spawn(["bun", ...args], { cwd: ROOT, stdout: "pipe", stderr: "ignore" });
      await new Response(p.stdout).text();
      await p.exited;
      try { verdicts.push(...JSON.parse(readFileSync(jsonPath, "utf-8"))); console.error(`ran ${op}`); break; } catch { console.error(`batch ${op} aborted (attempt ${attempt})`); }
    }
  }
  const byName = new Map(verdicts.map(v => [v.name, v]));
  for (const c of accepted) {
    const base = { op: c.op, repr: c.repr, type: c.tc.id, name: name(c) };
    const v = byName.get(name(c));
    const refusal = v?.refused.find(r => /Unsupported|not covered|unsupported/i.test(r) || r !== "ok") ?? "";
    const clean = (s: string) => s.replace(/\s+/g, " ").slice(0, 200);
    if (!v) rows.set(name(c), { ...base, status: "WRONG", message: "no verdict (harness lost the program)" });
    else if (v.verdict === "no-oracle") rows.set(name(c), { ...base, status: "no oracle", message: clean(v.detail ?? "") });
    else if (v.verdict === "same") rows.set(name(c), refusal ? { ...base, status: "refused", message: clean(refusal) } : { ...base, status: "covered", message: "" });
    else if (v.verdict === "build-differ") rows.set(name(c), { ...base, status: "refused", message: clean(refusal || v.detail || "build failed") });
    else rows.set(name(c), { ...base, status: "WRONG", message: clean(`${v.verdict}: ${v.detail ?? ""}${refusal ? ` [also refused: ${refusal}]` : ""}`) });
  }
}

if (filter) { // a filtered run updates the rows it covers and keeps the rest
  try { for (const r of JSON.parse(readFileSync(join(OUT, "ownership-cells.json"), "utf-8")) as Row[]) if (!rows.has(r.name)) rows.set(r.name, r); } catch {}
}
const list = [...rows.values()].sort((a, b) => a.name < b.name ? -1 : 1);
writeFileSync(join(OUT, "ownership-cells.json"), JSON.stringify(list, null, 1));
console.log("| op | repr | type | status | message |\n|---|---|---|---|---|");
for (const r of list) console.log(`| ${r.op} | ${r.repr} | ${r.type} | ${r.status}${r.expected ? ` (expected reject: ${r.expected})` : ""} | ${r.message.replace(/\|/g, "\\|")} |`);
const n = (s: Status) => list.filter(r => r.status === s).length;
console.log(`\ncells: ${n("covered")} covered, ${n("refused")} refused, ${n("WRONG")} WRONG, ${n("no oracle")} no oracle, ${n("rejected")} rejected`);
