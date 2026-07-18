function Base() { this.kind = "base"; }
Base.prototype.hello = function () { return "hello from " + this.kind; };
function Child() { Base.call(this); this.kind = "child"; }
Child.prototype = Object.create(Base.prototype);
Child.prototype.constructor = Child;
const c = new Child();
console.log(c.hello(), c.kind, c instanceof Child);
Child.staticThing = 5; console.log(Child.staticThing);
