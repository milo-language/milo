// The attribute vocabulary, in one place.
//
// Same reason src/lang-info.ts exists: a list the compiler acts on and everything else
// copies by hand is a list that rots. This one had rotted three ways at once before it
// was written down — `KNOWN_ATTRS` in the checker carried four names while the checker
// validated seven, two more lists lived inside error-message strings and had already
// drifted from each other, and `milo lang --json` did not report attributes at all, so
// no editor, linter or agent outside this repo could discover them. `@thread` and
// `@synchronized` shipped as safety-critical annotations and were invisible on every
// surface, including to the language's own author.
//
// `targets` is what the attribute may be written on; the checker derives its per-target
// checks from this rather than restating them. Adding an entry here is what makes an
// attribute known, documented in `milo lang --json`, and legal on its targets.
type AttrTarget = "fn" | "method" | "struct" | "extern";

interface AttrInfo {
  name: string;
  targets: AttrTarget[];
  /** One line, for `milo lang --json` and editor hovers. */
  doc: string;
  /** Whether it takes arguments, e.g. `@derive(Eq)`. */
  takesArgs?: boolean;
}

export const ATTRIBUTES: AttrInfo[] = [
  {
    name: "derive",
    targets: ["struct"],
    takesArgs: true,
    doc: "Generate an implementation the compiler can write itself, e.g. `@derive(Eq)`.",
  },
  {
    name: "noCopy",
    targets: ["struct"],
    doc:
      "This type is move-tracked however plain its fields are. A resource handle is often " +
      "an integer, so the all-fields-Copy rule would make it Copy and move checking would " +
      "never engage for exactly the type most likely to be used after release. Only needed " +
      "when the release is NOT a Drop impl, since Drop already forces non-Copy.",
  },
  {
    name: "copy",
    targets: ["struct"],
    doc:
      "This struct is Copy although it holds a raw pointer: it does not own what the pointer " +
      "points at. A pointer field otherwise makes a struct move-tracked, so an owning handle " +
      "cannot be duplicated by accident; `@copy` is the explicit claim for a C-owned record " +
      "or a view into a buffer some other value owns. Rejected on a struct with no pointer field.",
  },
  {
    name: "copyOnly",
    targets: ["struct", "fn"],
    takesArgs: true,
    doc:
      "A generic whose type parameters may only be instantiated with Copy types. The dual " +
      "of @noCopy: a container that moves elements through a raw pointer (std/shard's " +
      "`Shard<T>.get` returns `self.base[i]` bitwise) would hand out a second owner of a " +
      "heap-owning `T`, so `Shard<string>` is rejected at the instantiation, not at runtime. " +
      "Bare, it constrains every type parameter; `@copyOnly(T)` names the ones it applies to.",
  },
  {
    name: "copyOut",
    targets: ["fn", "method"],
    doc:
      "This generic hands a `T` out of a container by copy (`Option.Some(self.data[i])`). " +
      "The copy is structural and never runs a Drop, so it exists only for a `T` that " +
      "carries no Drop or @noCopy anywhere inside it: on a generic struct the method is " +
      "absent from an instantiation with such a `T` (calling it names this reason), and a " +
      "generic fn is rejected at the call. The rest of the type stays usable, which is " +
      "what @copyOnly on the whole struct could not give a container whose other methods " +
      "borrow.",
  },
  {
    name: "cLayout",
    targets: ["struct"],
    takesArgs: true,
    doc: "Check this struct's field layout against the real C header at build time.",
  },
  {
    name: "cSig",
    targets: ["extern", "fn"],
    takesArgs: true,
    doc:
      "Check an extern's signature against the real C header, e.g. " +
      "`@cSig(\"unistd.h\", \"long sysconf(int)\")`. Milo's types cannot express C type " +
      "identity, so the header is the oracle.",
  },
  {
    name: "wrapping",
    targets: ["fn", "method"],
    doc:
      "Arithmetic in this routine wraps instead of trapping on overflow. For code that is " +
      "inherently modular — an emulator's ALU, a hash mixer, a PRNG — so it need not spell " +
      "`wrappingAdd` at every operation. `@!wrapping` applies it to a whole file.",
  },
  {
    name: "pure",
    targets: ["fn", "method"],
    doc: "This function reads no global or module state; the checker enforces it.",
  },
  {
    name: "thread",
    targets: ["fn", "method"],
    doc:
      "This function hands a closure to a REAL OS thread. It is the single source of truth " +
      "for where a data race can enter a program: the checker holds such a closure's " +
      "captures to Send and rejects unsynchronized mutable globals reached from its body. " +
      "Declaring it here rather than hardcoding entry points is what stops the list " +
      "drifting — it already had, and a spawn with no arm shipped a pointer into a dead " +
      "frame to another thread.",
  },
  {
    name: "parks",
    targets: ["fn", "method", "extern"],
    doc:
      "This function may park the current green task. The checker forbids an element " +
      "view of a mutable global (a for-in binding, a slice, a `&` into an element) from " +
      "being live across a call to it: while the task is parked another task can push " +
      "to that global and free the buffer the view points into. Rooted at the extern " +
      "that switches context (`swapcontext`) and declared on the public primitives; " +
      "every caller inherits it transitively, so a wrapper nobody annotated is still seen.",
  },
  {
    name: "synchronized",
    targets: ["method"],
    doc:
      "This method's closure argument is a critical section: the primitive provides the " +
      "mutual exclusion and the happens-before edge, so a global written inside it is not " +
      "racing. Without it the canonical `Once.run(...)` one-shot init reports as the race " +
      "it prevents. The scan stops at the boundary, so a new synchronization type only has " +
      "to declare itself.",
  },
  {
    name: "unsafe",
    targets: ["fn"],
    doc:
      "Calling this function requires an `unsafe` block. For a routine whose contract the " +
      "compiler cannot check (`std/foreign`'s view constructors assert that a raw pointer " +
      "really addresses `len` initialized elements), where every operation in the body is " +
      "individually checkable and so no other rule would ever ask the CALLER to opt in.",
  },
  {
    name: "externalLinkage",
    targets: ["fn"],
    doc: "Give this function external C linkage so a dlopen'd library can resolve it.",
  },
  {
    name: "link",
    targets: ["fn", "extern"],
    takesArgs: true,
    doc: "Name the native library this extern is resolved from.",
  },
];

export const ATTRIBUTE_NAMES: string[] = ATTRIBUTES.map(a => a.name);

export function attributesFor(target: AttrTarget): string[] {
  return ATTRIBUTES.filter(a => a.targets.includes(target)).map(a => a.name);
}
