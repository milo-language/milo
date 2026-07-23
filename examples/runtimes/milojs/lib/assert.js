// node:assert — the CommonJS subset real code uses. assert(value[, message]) is
// callable directly and also carries the method surface.

function AssertionError(message) {
  var e = new Error(message || "Assertion failed");
  e.name = "AssertionError";
  e.code = "ERR_ASSERTION";
  return e;
}

function fail(message) {
  throw AssertionError(typeof message === "string" ? message : "Failed");
}

function ok(value, message) {
  if (!value) {
    throw AssertionError(message || "The expression evaluated to a falsy value");
  }
}

// structural equality for deepEqual/deepStrictEqual. `strict` uses === on leaves.
function deepEq(a, b, strict) {
  if (strict ? a === b : a == b) {
    return true;
  }
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    // NaN is equal to itself under assert's deep comparison
    return a !== a && b !== b;
  }
  var aArr = Array.isArray(a);
  var bArr = Array.isArray(b);
  if (aArr !== bArr) {
    return false;
  }
  var ka = Object.keys(a);
  var kb = Object.keys(b);
  if (ka.length !== kb.length) {
    return false;
  }
  for (var i = 0; i < ka.length; i++) {
    var k = ka[i];
    if (!Object.prototype.hasOwnProperty.call(b, k)) {
      return false;
    }
    if (!deepEq(a[k], b[k], strict)) {
      return false;
    }
  }
  return true;
}

function assert(value, message) {
  ok(value, message);
}

assert.AssertionError = AssertionError;
assert.ok = ok;
assert.fail = fail;

assert.equal = function (actual, expected, message) {
  if (!(actual == expected)) {
    throw AssertionError(message || actual + " == " + expected);
  }
};
assert.notEqual = function (actual, expected, message) {
  if (actual == expected) {
    throw AssertionError(message || actual + " != " + expected);
  }
};
assert.strictEqual = function (actual, expected, message) {
  if (!(actual === expected)) {
    throw AssertionError(message || actual + " === " + expected);
  }
};
assert.notStrictEqual = function (actual, expected, message) {
  if (actual === expected) {
    throw AssertionError(message || actual + " !== " + expected);
  }
};
assert.deepEqual = function (actual, expected, message) {
  if (!deepEq(actual, expected, false)) {
    throw AssertionError(message || "deepEqual failed");
  }
};
assert.notDeepEqual = function (actual, expected, message) {
  if (deepEq(actual, expected, false)) {
    throw AssertionError(message || "notDeepEqual failed");
  }
};
assert.deepStrictEqual = function (actual, expected, message) {
  if (!deepEq(actual, expected, true)) {
    throw AssertionError(message || "deepStrictEqual failed");
  }
};
assert.notDeepStrictEqual = function (actual, expected, message) {
  if (deepEq(actual, expected, true)) {
    throw AssertionError(message || "notDeepStrictEqual failed");
  }
};
assert.throws = function (fn, expected, message) {
  var threw = false;
  var err = null;
  try {
    fn();
  } catch (e) {
    threw = true;
    err = e;
  }
  if (!threw) {
    throw AssertionError(message || "Missing expected exception");
  }
  // (expected as a validator: a RegExp against the message, or a predicate)
  if (expected instanceof RegExp && !expected.test(String(err && err.message))) {
    throw AssertionError(message || "Exception did not match " + expected);
  }
  if (typeof expected === "function" && !(expected instanceof RegExp)) {
    // could be an Error constructor or a predicate; a predicate returns falsy to fail
    try {
      if (!(err instanceof expected)) {
        // not a constructor match — try as a predicate
        if (expected(err) === false) {
          throw AssertionError(message || "Exception validation failed");
        }
      }
    } catch (ignore) {
      // `err instanceof expected` throws when expected isn't a constructor;
      // fall back to treating it as a predicate
      if (expected(err) === false) {
        throw AssertionError(message || "Exception validation failed");
      }
    }
  }
};
assert.doesNotThrow = function (fn, message) {
  try {
    fn();
  } catch (e) {
    throw AssertionError(message || "Got unwanted exception: " + (e && e.message));
  }
};
assert.ifError = function (value) {
  if (value !== null && value !== undefined) {
    throw AssertionError("ifError got unwanted exception: " + value);
  }
};
// assert.strict is a DISTINCT function (=== assert is false) whose loose
// variants (equal/deepEqual) behave like the strict ones.
function strictAssert(value, message) {
  ok(value, message);
}
strictAssert.AssertionError = AssertionError;
strictAssert.ok = ok;
strictAssert.fail = fail;
strictAssert.equal = assert.strictEqual;
strictAssert.notEqual = assert.notStrictEqual;
strictAssert.strictEqual = assert.strictEqual;
strictAssert.notStrictEqual = assert.notStrictEqual;
strictAssert.deepEqual = assert.deepStrictEqual;
strictAssert.notDeepEqual = assert.notDeepStrictEqual;
strictAssert.deepStrictEqual = assert.deepStrictEqual;
strictAssert.notDeepStrictEqual = assert.notDeepStrictEqual;
strictAssert.throws = assert.throws;
strictAssert.doesNotThrow = assert.doesNotThrow;
strictAssert.ifError = assert.ifError;
strictAssert.strict = strictAssert;
assert.strict = strictAssert;

module.exports = assert;
