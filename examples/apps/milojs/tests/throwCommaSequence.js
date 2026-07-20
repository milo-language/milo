// `throw a = x, e` throws e: the comma operator is part of the thrown
// Expression, not a statement separator. Stopping at the comma threw the
// assignment's value instead — prisma re-throws as
// `throw err.clientVersion = this._clientVersion, err`, so every error arrived
// as the bare version string with no message.
const err = new Error("real message");
try {
  throw err.tag = "5.7.1", err;
} catch (e) {
  console.log(typeof e, e.message, e.tag);
}
// the comma operator itself still yields its right operand
console.log((1, 2, 3));
const o = {};
console.log(typeof (o.a = "x", o), o.a);
try {
  throw "plain string";
} catch (e) {
  console.log(typeof e, e);
}
