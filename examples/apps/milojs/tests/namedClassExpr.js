// a named class expression binds its own name inside the class body
const List = class Node {
  constructor(head) { this.head = head; }
  static empty() { return new Node(null); }
  clone() { return new Node(this.head); }
};
console.log(List.empty().head);
console.log(new List(3).clone().head);
// the inner name must not leak to the enclosing scope
console.log(typeof Node);
// two anonymous classes in one scope keep separate super bindings
const A = class extends Object {};
const B = class extends Object {};
console.log(new A() instanceof A, new B() instanceof B);
