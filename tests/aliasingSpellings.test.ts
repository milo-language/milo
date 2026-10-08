// The SPELLING matrix for the "mutation during iteration" rule.
//
// Distinct from tests/aliasingMatrix.test.ts, which is a golden matrix over containers
// x operations. This file varies how the same container is NAMED and how the loop body
// REACHES it, which is the axis the use-after-frees kept escaping along.
//
// Every use-after-free found in this checker in safe code has had one shape: an aliasing
// rule written against a node KIND rather than a place, so it covered the spelling its
// author was looking at and silently exempted the siblings. `for x in v` was rejected
// and `for x in b.items` was a heap-use-after-free, because the freeze only fired for a
// bare Ident.
//
// So the coverage question ("did I handle every spelling?") is answered here by
// generation instead of by memory. Each container is crossed with each way of NAMING it
// and each route by which the loop body can reach it. A rule that covers one spelling
// fails this file immediately rather than years later under ASan.
//
// Adding a container or a new root spelling means adding a row, not remembering to go
// re-audit the checker. See docs/plans/aliasing-coverage.md.
import { test, expect, describe } from "bun:test";
import { mkdtempSync } from "fs";
import { writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { Lexer } from "../src/lexer";
import { Parser } from "../src/parser";
import { TypeChecker } from "../src/checker";

const dir = mkdtempSync(join(tmpdir(), "milo-alias-"));
let n = 0;

function errorsFor(src: string): string[] {
  const entry = join(dir, `m${n++}.milo`);
  writeFileSync(entry, src);
  const prog = new Parser(new Lexer(src).tokenize(), src, entry).parse();
  return new TypeChecker().check(prog).diagnostics
    .filter(d => d.severity === "error").map(d => d.message);
}

type Container = {
  name: string;
  ty: string;
  init: string;
  /** seed the container so the loop has something to iterate */
  seed: (place: string) => string;
  /** the mutation that must be rejected inside the loop */
  mutate: (place: string) => string;
  /** loop bindings — a map yields two */
  bind: string;
};

const CONTAINERS: Container[] = [
  {
    name: "Vec",
    ty: "Vec<string>",
    init: "Vec.new()",
    seed: p => `${p}.push("a")`,
    mutate: p => `${p}.push("z")`,
    bind: "it",
  },
  {
    name: "HashMap",
    ty: "HashMap<string, string>",
    init: "HashMap.new()",
    seed: p => `${p}.insert("a", "b")`,
    mutate: p => `${p}.insert("z", "z")`,
    bind: "k, it",
  },
  {
    name: "Array",
    ty: "[string; 2]",
    init: `["a", "b"]`,
    seed: () => "",
    mutate: p => `${p}[0] = "z"`,
    bind: "it",
  },
];

type Root = {
  name: string;
  /** struct declarations this spelling needs */
  decls: (ty: string) => string;
  /** how `main` builds it */
  setup: (ty: string, init: string) => string;
  /** the binding the loop's root resolves to */
  owner: string;
  /** the owner's type, for a `&mut` parameter */
  ownerTy: (ty: string) => string;
  /** steps from the owner down to the container */
  path: string;
  /** the type an `impl` block can hang off, or null when the owner is a builtin */
  implTarget: string | null;
  /** steps from `self` down to the container, inside that impl */
  implPath: string;
};

const ROOTS: Root[] = [
  {
    name: "local",
    decls: () => "",
    setup: (ty, init) => `    var c: ${ty} = ${init}`,
    owner: "c",
    ownerTy: ty => ty,
    path: "",
    implTarget: null,
    implPath: "",
  },
  {
    name: "field",
    decls: ty => `struct Holder { c: ${ty} }`,
    setup: (_ty, init) => `    var h = Holder { c: ${init} }`,
    owner: "h",
    ownerTy: () => "Holder",
    path: ".c",
    implTarget: "Holder",
    implPath: ".c",
  },
  {
    name: "nested field",
    decls: ty => `struct Inner { c: ${ty} }\nstruct Outer { i: Inner }`,
    setup: (_ty, init) => `    var o = Outer { i: Inner { c: ${init} } }`,
    owner: "o",
    ownerTy: () => "Outer",
    path: ".i.c",
    implTarget: "Outer",
    implPath: ".i.c",
  },
  {
    // An index step makes the path imprecise about WHICH element, which is exactly the
    // spot where a walker is tempted to give up and return "no place" — and "no place"
    // read as "nothing to check" is how this class of hole gets made.
    name: "index element",
    decls: ty => `struct G { c: ${ty} }`,
    setup: (_ty, init) => `    var v: Vec<G> = Vec.new()\n    v.push(G { c: ${init} })`,
    owner: "v",
    ownerTy: () => "Vec<G>",
    path: "[0].c",
    implTarget: null,
    implPath: "",
  },
  {
    name: "global",
    decls: ty => `var GC: ${ty} = INIT_PLACEHOLDER`,
    setup: () => "",
    owner: "GC",
    ownerTy: ty => ty,
    path: "",
    implTarget: null,
    implPath: "",
  },
];

// How the loop body reaches the container. The routes matter as much as the spellings:
// a rule can resolve the place correctly and still miss it if the mutation arrives
// through a call it never inspects.
type Route = {
  name: string;
  /** not every route fits every root — a bare `Vec<string>` local has no impl block */
  applicable: (r: Root) => boolean;
  /** top-level declarations this route needs */
  decls: (c: Container, r: Root) => string;
  /** what goes in the loop body */
  body: (c: Container, r: Root) => string;
};

const ROUTES: Route[] = [
  {
    name: "direct",
    applicable: () => true,
    decls: () => "",
    body: (c, r) => c.mutate(r.owner + r.path),
  },
  {
    name: "through a &mut fn",
    applicable: () => true,
    decls: (c, r) => `fn touch(x: &mut ${r.ownerTy(c.ty)}) {\n    ${c.mutate("x" + r.path)}\n}\n`,
    body: (_c, r) => `touch(${r.owner})`,
  },
  {
    // Two hops, because a one-level check can be satisfied by inspecting the immediate
    // callee's signature; this one is only caught by treating the borrow as live across
    // the whole call.
    name: "through a two-level &mut chain",
    applicable: () => true,
    decls: (c, r) =>
      `fn inner(x: &mut ${r.ownerTy(c.ty)}) {\n    ${c.mutate("x" + r.path)}\n}\nfn outer(x: &mut ${r.ownerTy(c.ty)}) {\n    inner(x)\n}\n`,
    body: (_c, r) => `outer(${r.owner})`,
  },
  {
    name: "through a method on the owner",
    applicable: r => r.implTarget !== null,
    decls: (c, r) =>
      `impl ${r.implTarget} {\n    fn touch(self: &mut ${r.implTarget}) {\n        ${c.mutate("self" + r.implPath)}\n    }\n}\n`,
    body: (_c, r) => `${r.owner}.touch()`,
  },
  {
    name: "from inside a closure",
    applicable: () => true,
    decls: () => "",
    body: (c, r) => `let f = () => { ${c.mutate(r.owner + r.path)} }\n        f()`,
  },
];

function program(c: Container, r: Root, route: Route): string {
  const place = r.owner + r.path;
  const seed = c.seed(place);
  const decls = r.decls(c.ty).replace("INIT_PLACEHOLDER", c.init);
  return `${decls}\n${route.decls(c, r)}\nfn main() {\n${r.setup(c.ty, c.init)}\n${seed ? `    ${seed}\n` : ""}    for ${c.bind} in ${place} {\n        ${route.body(c, r)}\n        print(it)\n    }\n}\n`;
}

describe("mutation during iteration is rejected for every spelling", () => {
  for (const c of CONTAINERS) {
    for (const r of ROOTS) {
      for (const route of ROUTES) {
        if (!route.applicable(r)) continue;
        test(`${c.name} as a ${r.name}, mutated ${route.name}`, () => {
          const errs = errorsFor(program(c, r, route));
          // Either wording is the rule firing: a mutating METHOD reports the borrow,
          // an element ASSIGNMENT reports the iteration. Both are a rejection.
          expect(errs.join("\n")).toMatch(/is borrowed|being iterated|while a loop iterates over|while a closure captures/);
        });
      }
    }
  }
});

// Anti-vacuity control. A matrix that only asserts REJECTION passes just as happily if
// the generator emits programs that fail for some unrelated reason — a syntax slip in a
// template would look exactly like full coverage. So every (container, root) pair is also
// generated with a benign body and required to compile clean. If these go red, the
// rejection rows above are not evidence of anything.
describe("the same loop without the mutation compiles", () => {
  for (const c of CONTAINERS) {
    for (const r of ROOTS) {
      test(`${c.name} as a ${r.name}`, () => {
        const benign: Route = {
          name: "none", applicable: () => true, decls: () => "", body: () => `print(it)`,
        };
        expect(errorsFor(program(c, r, benign))).toEqual([]);
      });
    }
  }
});

// The rule has to be precise as well as total: freezing the ROOT must not reject a
// mutation of a sibling field, or every `for x in self.items { self.count += 1 }` in the
// stdlib stops compiling. This is the half that a blunt "freeze the whole struct" fix
// would break, so it is asserted rather than assumed.
describe("a disjoint field of the same root still compiles", () => {
  for (const c of CONTAINERS) {
    test(`${c.name}: iterate one field, mutate another`, () => {
      const src = `struct Two { c: ${c.ty}, other: Vec<string>, n: i64 }\n\nfn main() {\n    var t = Two { c: ${c.init}, other: Vec.new(), n: 0 }\n${c.seed("t.c") ? `    ${c.seed("t.c")}\n` : ""}    for ${c.bind} in t.c {\n        t.other.push("ok")\n        t.n = t.n + 1\n        print(it)\n    }\n}\n`;
      expect(errorsFor(src)).toEqual([]);
    });
  }
});
