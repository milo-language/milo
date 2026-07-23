// QuickJS's `qjs:std` host module — only the surface its own test suite touches.
// Present so a test that imports std for one helper still gets graded on
// everything else it asserts, instead of dying at the import.
module.exports = {
  // the real collector, so GC/finalization tests actually exercise something
  gc: gc,
  printf: function () {
    console.log.apply(console, arguments);
  },
  exit: function (code) {
    process.exit(code || 0);
  },
};
