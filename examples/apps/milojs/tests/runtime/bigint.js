// BigInt: arbitrary-precision literals, arithmetic, radix, bitwise, conversion.
console.log(BigInt(42), typeof BigInt(42), BigInt("12345678901234567890"));
console.log((10n + 5n), (999n).toString(), (255n).toString(16), (10n).toString(2));
console.log(String(123n), String(-5n), `val=${99n}`);
try { 10n + 5; } catch (e) { console.log("mix:", e.constructor.name); }
try { 5n / 0n; } catch (e) { console.log("divzero:", e.constructor.name); }
console.log(3n ** 4n, 10n > 3n, 3n < 10n, -6n, -7n);
console.log([3n, 1n, 2n].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)).join(","));
console.log(typeof 1n, Boolean(0n), Boolean(1n), 0n === 0);
console.log(2n ** 100n);
console.log(BigInt(true), BigInt(false), 100n / 7n, 100n % 7n);
console.log(Number(123n), 123n == 123, 123n === 123);
// radix-prefixed literals + strings, full precision
console.log(0xffn, 0b1010n, 0o17n, 0xABCDEF123456789ABCDEFn);
console.log(BigInt("0xff"), BigInt("0b1010"), (0xABCDEF123456789ABCDEFn).toString(16));
console.log((123456789012345678901234567890n).toString(16));
// bitwise, including two's-complement negatives + shifts
console.log(0xffn & 0x0fn, 0xf0n | 0x0fn, 0xffn ^ 0x0fn);
console.log(1n << 64n, 1024n >> 2n, (1n << 64n).toString(16));
console.log(-1n & 1n, -8n & 5n, -255n & -16n, ~5n, ~-1n);
console.log(12345678901234567890n & 987654321987654321n);
try { 5n >>> 1n; } catch (e) { console.log("unsigned:", e.constructor.name); }
