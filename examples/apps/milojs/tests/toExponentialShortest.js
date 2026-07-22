// toExponential() with no argument = shortest round-trip (was full-f64-precision)
console.log((12345).toExponential(), (0.00042).toExponential(), (0).toExponential(), (0.1).toExponential());
console.log((-42.7).toExponential(), (1).toExponential(), (100).toExponential(), (1e21).toExponential(), (1e-30).toExponential());
console.log((123.456).toExponential(), (9.99).toExponential(), (1/3).toExponential());
console.log((12345).toExponential(2), (1.5).toExponential(3), (9.99).toExponential(1));
