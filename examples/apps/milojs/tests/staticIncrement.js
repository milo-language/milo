// ++/--/compound assignment on a class static (the base is a function value, not
// an object, so readLValue/writeLValue must resolve to its statics).
class E { static n = 5; static bump() { E.n++; return E.n; } }
console.log(E.bump(), E.n);
class F { static c = 0; constructor() { F.c++; } }
new F(); new F(); console.log(F.c);
class G { static n = 5; }
G.n += 3; console.log(G.n);
--G.n; console.log(G.n);
G.arr = [1]; G.arr[0]++; console.log(G.arr[0]);
