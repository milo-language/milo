// Generates a JSON conformance fixture from the canonical json.org JSON_checker
// suite (fail1..33, pass1..3) as vendored by CPython's test_json.
//
// Expectations are RFC 8259-correct, NOT the 2007 json.org file verbatim:
//   - fail1 (top-level string) and fail18 (deep nesting) are ACCEPTED per RFC 8259;
//     CPython itself skips these two. Encoding that distinction is the point —
//     it proves we track the live spec, not a stale test file.
//
// Modes:
//   probe  -> emit a milo program that prints one line per MISMATCH plus a
//             "mismatches=N" summary. Used to discover where the parser stands.
//   lock   -> given a comma-separated list of case names to EXCLUDE (known
//             deviations), emit the green regression fixture over the rest.

type Expect = "accept" | "reject";
interface Case { name: string; raw: string; expect: Expect; note?: string }

// raw holds the exact bytes fed to the parser. Use \u/\t/\n etc. as real chars.
const CASES: Case[] = [
  { name: "fail1_toplevel_string", raw: '"A JSON payload should be an object or array, not a string."', expect: "accept", note: "RFC 8259 §2 allows any value at top level" },
  { name: "fail2_unclosed_array", raw: '["Unclosed array"', expect: "reject" },
  { name: "fail3_unquoted_key", raw: '{unquoted_key: "keys must be quoted"}', expect: "reject" },
  { name: "fail4_extra_comma", raw: '["extra comma",]', expect: "reject" },
  { name: "fail5_double_extra_comma", raw: '["double extra comma",,]', expect: "reject" },
  { name: "fail6_missing_value", raw: '[   , "<-- missing value"]', expect: "reject" },
  { name: "fail7_comma_after_close", raw: '["Comma after the close"],', expect: "reject" },
  { name: "fail8_extra_close", raw: '["Extra close"]]', expect: "reject" },
  { name: "fail9_trailing_comma_obj", raw: '{"Extra comma": true,}', expect: "reject" },
  { name: "fail10_value_after_close", raw: '{"Extra value after close": true} "misplaced quoted value"', expect: "reject" },
  { name: "fail11_illegal_expr", raw: '{"Illegal expression": 1 + 2}', expect: "reject" },
  { name: "fail12_illegal_invocation", raw: '{"Illegal invocation": alert()}', expect: "reject" },
  { name: "fail13_leading_zero", raw: '{"Numbers cannot have leading zeroes": 013}', expect: "reject" },
  { name: "fail14_hex_number", raw: '{"Numbers cannot be hex": 0x14}', expect: "reject" },
  { name: "fail15_bad_escape_x", raw: '["Illegal backslash escape: \\x15"]', expect: "reject" },
  { name: "fail16_naked_escape", raw: '[\\naked]', expect: "reject" },
  { name: "fail17_bad_escape_octal", raw: '["Illegal backslash escape: \\017"]', expect: "reject" },
  { name: "fail18_deep_nesting", raw: '[[[[[[[[[[[[[[[[[[[["Too deep"]]]]]]]]]]]]]]]]]]]]', expect: "accept", note: "RFC 8259 sets no depth limit" },
  { name: "fail19_missing_colon", raw: '{"Missing colon" null}', expect: "reject" },
  { name: "fail20_double_colon", raw: '{"Double colon":: null}', expect: "reject" },
  { name: "fail21_comma_for_colon", raw: '{"Comma instead of colon", null}', expect: "reject" },
  { name: "fail22_colon_for_comma", raw: '["Colon instead of comma": false]', expect: "reject" },
  { name: "fail23_bad_value", raw: '["Bad value", truth]', expect: "reject" },
  { name: "fail24_single_quote", raw: "['single quote']", expect: "reject" },
  { name: "fail25_tab_in_string", raw: '["\ttab\tcharacter\tin\tstring\t"]', expect: "reject", note: "raw control char U+0009 in string is illegal" },
  { name: "fail26_escaped_tab_literal", raw: '["tab\\   character\\   in\\  string\\  "]', expect: "reject" },
  { name: "fail27_raw_newline_in_string", raw: '["line\nbreak"]', expect: "reject" },
  { name: "fail28_escaped_newline_continuation", raw: '["line\\\nbreak"]', expect: "reject" },
  { name: "fail29_bare_exp", raw: '[0e]', expect: "reject" },
  { name: "fail30_exp_no_digits", raw: '[0e+]', expect: "reject" },
  { name: "fail31_exp_garbage", raw: '[0e+-1]', expect: "reject" },
  { name: "fail32_comma_no_close", raw: '{"Comma instead if closing brace": true,', expect: "reject" },
  { name: "fail33_mismatch_bracket", raw: '["mismatch"}', expect: "reject" },
  { name: "fail34_control_in_string", raw: '["AZ control characters in string"]', expect: "reject", note: "U+001F unescaped" },
  // Canonical pass docs (pass1 trimmed to the parts our parser must accept).
  { name: "pass3_nested_object", raw: '{\n "JSON Test Pattern pass3": {\n  "The outermost value": "must be an object or array.",\n  "In this test": "It is an object."\n }\n}', expect: "accept" },
  // A compact slice of pass1 exercising types, escapes, exponents, nesting.
  { name: "pass1_mixed", raw: '[{"integer":1234567890,"real":-9876.543210,"e":0.123456789e-12,"E":1.234567890E+34,"":23456789012E66,"zero":0,"one":1,"space":" ","quote":"\\"","backslash":"\\\\","controls":"\\b\\f\\n\\r\\t","slash":"/ & \\/","unicode":"\\u0123\\u4567\\u89AB","true":true,"false":false,"null":null,"array":[],"object":{},"jsontext":"{\\"object with 1 member\\":[\\"array with 1 element\\"]}"}]', expect: "accept" },
];

// Milo string-literal escaper: emit a literal that round-trips to `raw` bytes.
function lit(s: string): string {
  let out = '"';
  for (const ch of s) {
    const c = ch.codePointAt(0)!;
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    // milo's lexer supports \xNN hex escapes (not \uNNNN), so embed C0 control bytes that way.
    else if (c < 0x20) out += "\\x" + c.toString(16).padStart(2, "0");
    else out += ch;
  }
  return out + '"';
}

const mode = process.argv[2] ?? "probe";
const exclude = new Set((process.argv[3] ?? "").split(",").map(s => s.trim()).filter(Boolean));
const summaryVar = mode === "probe" ? "mism" : "fails";

function checkLine(c: Case): string {
  const want = c.expect === "accept";
  return `    ${summaryVar} = ${summaryVar} + ck(${lit(c.raw)}, ${want}, "${c.name}")`;
}

const active = CASES.filter(c => !exclude.has(c.name));

const header = mode === "probe"
  ? `// probe (not a committed fixture)\n`
  : `// JSON conformance: json.org JSON_checker suite (via CPython), RFC 8259 expectations.\n` +
    `// Generated by scripts/gen-json-conformance.ts. Excluded (known deviations): ` +
    `${[...exclude].join(", ") || "none"}.\n// @expect: conformance fails=0\n`;

const body = active.map(checkLine).join("\n");

const mismatchPrint = mode === "probe"
  ? `        print("MISMATCH ", name, " want=", want, " got=", got)`
  : `        print("FAIL ", name)`;

const prog = `${header}
from "std/json" import { jsonParse }

fn ck(input: string, want: bool, name: string): i64 {
    var got: bool = false
    match jsonParse(input) {
        Result.Ok(j) => { got = true }
        Result.Err(e) => { got = false }
    }
    if got != want {
${mismatchPrint}
        return 1
    }
    return 0
}

fn main(): i32 {
    var ${summaryVar}: i64 = 0
${body}
${mode === "probe"
  ? `    print("mismatches=", mism)`
  : `    print("conformance fails=", fails)`}
    return 0
}
`;

process.stdout.write(prog);
