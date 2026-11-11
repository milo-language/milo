<!-- doc-meta
system: site-traceability
purpose: the public walkthrough of requirements traceability in Milo: what it is, why safety-critical teams use it, requirements.json, @req, milo trace output, commands per activity
key-files: src/object-trace.ts, examples/assured/pid/README.md, docs/site/language/assurance.md
update-when: trace output format changes, a command is added, or a planned item ships
last-verified: 2026-11-11 (moved from the landing page)
-->

# Requirements traceability

A requirement is a statement of what the software must do, written so that it can be tested. Bidirectional traceability means every requirement links to the code and tests that satisfy it, and every function, test and instruction in the binary links back to a requirement. Nothing required is missing, and nothing is there without a reason.

Safety-critical software is built this way, to standards such as DO-178C in avionics. The process is robust because no single person is a single point of failure. Requirements, code and tests are written and reviewed independently and checked against each other, so a mistake in one is caught by another.

On most projects each part of the trace lives in a different tool. Requirements are in a requirements database such as DOORS. The link to source is a requirement ID in a comment or a docstring. Tests and coverage come from other tools, and object code is analysed separately. None of this is part of the language, so every team writes its own scripts to connect the tools and keep them in sync.

Milo makes the whole trace part of the language and the compiler: requirements, source, proofs, tests and object code, in both directions. It works the same for code written by a person or by an AI agent.

Requirements are entries in `requirements.json`. A high-level requirement (HLR) says what the system must do. A low-level requirement (LLR) says how the software does it, and names the high-level requirement it comes from as its `parent`:

```json
[
  {
    "id": "HLR-1",
    "text": "The actuator command shall always lie within the configured output range."
  },
  {
    "id": "LLR-1",
    "parent": "HLR-1",
    "text": "Every command is clamped to [outLo, outHi] on its way out of the PID step."
  }
]
```

A function is tagged with the requirement it implements. A contract states the requirement formally:

```milo
@req(LLR-1)
pub fn clampI32(v: i32, lo: i32, hi: i32): i32
requires lo <= hi
@req(LLR-1)
ensures result >= lo && result <= hi
{
    if v < lo { return lo }
    if v > hi { return hi }
    return v
}
```

`milo trace` prints the trace for each requirement: source, object code, proofs and tests. Low-level requirements are listed under the high-level requirement they come from. This is HLR-1 and LLR-1 (HLR-1 has a second low-level requirement, LLR-3, not shown):

```
$ milo trace pid.milo --strict --object pid
HLR-1  The actuator command shall always lie within the configured output range.
  implemented   (through LLR-1, LLR-3)
  formalized    PROVEN   pid.milo:97 ensures result >= 0 && result <= 16711680  [controlTick]
  verified      PASS      pid_test.milo:15 testStepOutputWithinRange

  LLR-1  Every command is clamped to [outLo, outHi] on its way out of the PID step.
    implemented   pid.milo:27 clampI32
    implemented   pid.milo:44 pidStep
    object        0x100000680-0x1000006b0 (48 B) clampI32  lines 28-32
    object        0x1000006c0-0x100000848 (392 B) pidStep  lines 32-68
    object        0x1000008b4-0x1000008d8 (36 B) nextIntegral  lines 32-32
    object        0x100000900-0x100000918 (24 B) clampInput  lines 32-32
    object        0x10000097c-0x100000998 (28 B) controlTick  lines 32-32
    formalized    PROVEN   pid.milo:30 ensures result >= lo && result <= hi  [clampI32]
    formalized    PROVEN   pid.milo:57 ensures result >= outLo && result <= outHi  [pidStep]
    verified      PROOF     2 formalizing clauses PROVEN
    verified      PASS      pid_test.milo:7 testClampKeepsValueInRange
    verified      PASS      pid_test.milo:15 testStepOutputWithinRange
```

`milo trace-object --strict` checks the other direction. Every instruction in the binary must map to a source line or to a language rule (bounds check, overflow trap, contract check, drop).

## Commands for each activity

| Activity | Command |
|---|---|
| Requirements change control | `milo spec --diff` fails when a requirement or contract is weakened, until a person signs off the change. |
| Source traces to requirements | `milo trace --strict` fails on a function with no `@req`. |
| Requirements verification | `milo prove` proves the contract for all inputs, or a test tagged with the requirement passes. |
| Requirements-based tests | `milo spec --packet` exports signatures and contracts without function bodies, so tests can be written without seeing the implementation. |
| Structural coverage | `milo trace --coverage` reports line coverage of the implementing code. |
| Source to object code traceability | `milo trace --object` and `milo trace-object --strict`. |
| Reviews and manual tests | `milo evidence` records the result and marks it stale when the requirement or its code changes. |

Not built yet: branch and MC/DC coverage, and translation validation of the compiler. The tools are not qualified under DO-330. [How Milo is checked](/language/assurance) lists what is built and what is planned.
