class Animal {
  constructor(name) { this.name = name; }
  speak() { return this.name + " makes a noise"; }
  static create(n) { return new Animal(n); }
}
class Dog extends Animal {
  constructor(name) { super(name); this.kind = "dog"; }
  speak() { return this.name + " barks"; }
  parentSpeak() { return Animal.prototype.speak.call(this); }
}
console.log(new Animal("Rex").speak());
const d = new Dog("Fido");
console.log(d.speak(), d.kind, d.name);
console.log(d.parentSpeak());
console.log(Animal.create("Z").speak());
console.log(d instanceof Dog, d instanceof Animal);
class Empty {}
console.log(typeof new Empty());
const Anon = class { hi() { return "anon"; } };
console.log(new Anon().hi());
