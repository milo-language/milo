import { test, expect, describe } from "bun:test";
import { orderGuardIncludes } from "../src/codegen";

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
