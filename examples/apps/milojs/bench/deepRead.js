// Pair B variant: same loop, but `target` lives 6 function scopes up, and each
// intervening scope carries decoy bindings so the backwards linear scan of
// Vec<Binding> has real work to do at every level before following `parent`.
const N = 1000000;
function run() {
  let target = 7;
  let d0 = 1, d1 = 2, d2 = 3, d3 = 4;
  function l1() {
    let e0 = 1, e1 = 2, e2 = 3, e3 = 4;
    function l2() {
      let f0 = 1, f1 = 2, f2 = 3, f3 = 4;
      function l3() {
        let g0 = 1, g1 = 2, g2 = 3, g3 = 4;
        function l4() {
          let h0 = 1, h1 = 2, h2 = 3, h3 = 4;
          function l5() {
            let sink = 0;
            for (let i = 0; i < N; i++) {
              sink = sink + target;
            }
            return sink;
          }
          return l5();
        }
        return l4();
      }
      return l3();
    }
    return l2();
  }
  return l1();
}
console.log(run());
