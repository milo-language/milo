import { test, expect, describe } from "bun:test";
import { guardFeatureMacros, orderGuardIncludes } from "../src/c-guards";

// The @cLayout/@cSig guard TU only compiles on Windows if winsock2.h precedes the
// headers that depend on it. Only CI's windows-latest job compiles that TU for real
// (verifyCDecls skips itself on any cross-compile), so a mac/linux run would never
// notice a regression here — these assertions are the local guard against it.
describe("c-decl guard include order", () => {
  test("winsock2.h leads on windows, whatever the sort said", () => {
    expect(orderGuardIncludes(["afunix.h", "winsock2.h", "ws2tcpip.h"], "windows"))
      .toEqual(["winsock2.h", "afunix.h", "ws2tcpip.h"]);
  });

  test("winsock2.h is added for a dependent that arrives alone", () => {
    expect(orderGuardIncludes(["ws2tcpip.h"], "windows")).toEqual(["winsock2.h", "ws2tcpip.h"]);
  });

  test("untouched when no winsock header is involved", () => {
    expect(orderGuardIncludes(["stdio.h", "sys/stat.h"], "windows")).toEqual(["stdio.h", "sys/stat.h"]);
  });

  test("posix targets keep the sorted order", () => {
    expect(orderGuardIncludes(["afunix.h", "winsock2.h"], "darwin")).toEqual(["afunix.h", "winsock2.h"]);
  });
});

// A feature-test macro has to be defined before the FIRST system header in the TU, not
// before the header that names it: glibc latches the feature set in <features.h>, which
// whatever includes first drags in. Emitted per-header, `#define _GNU_SOURCE` landed after
// <stddef.h> and execvpe stayed hidden, so the guard reported that Milo declared a function
// C does not have — exactly backwards, and only on Linux, and only once flybyGeometry got
// far enough to reach it.
describe("c-decl guard feature macros", () => {
  test("pulled out of a FEATURE+header spec", () => {
    expect(guardFeatureMacros(["_GNU_SOURCE+unistd.h"])).toEqual(["_GNU_SOURCE"]);
  });

  test("pulled out of every alternate, deduped", () => {
    expect(guardFeatureMacros(["OpenGL/gl3.h|GL_GLEXT_PROTOTYPES+GL/glcorearb.h", "_GNU_SOURCE+sched.h", "_GNU_SOURCE+unistd.h"]))
      .toEqual(["GL_GLEXT_PROTOTYPES", "_GNU_SOURCE"]);
  });

  test("a plain header contributes nothing", () => {
    expect(guardFeatureMacros(["stdio.h", "sys/stat.h", "OpenGL/gl3.h|GL/glcorearb.h"])).toEqual([]);
  });
});
