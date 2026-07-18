// depd — deprecation warnings. The real implementation builds wrapper functions
// with eval and walks V8 CallSite objects for the call location; neither exists
// here, and its only observable effect is a message on stderr. This returns a
// deprecate() that passes calls straight through.
module.exports = function depd(namespace) {
  function deprecate(message) {
    // real depd prints to stderr on first use; staying silent keeps the target's
    // output clean, and nothing branches on the warning
  }
  deprecate.function = function (fn, message) { return fn; };
  deprecate.property = function (obj, prop, message) { return obj; };
  deprecate._namespace = namespace;
  deprecate._traced = false;
  deprecate._warned = {};
  return deprecate;
};
