// Byte length vs code-point length. Engine strings hold UTF-8 bytes, so `.length`
// (code points) under-reports any content with multi-byte sequences. Content-Length
// built from it truncates binary responses — this locks the byte-accurate path.
var Buffer = require('buffer').Buffer;

// "é" is 2 UTF-8 bytes, "€" is 3, "𝄞" is 4
var s = "aé€𝄞";
console.log("byteLength: " + Buffer.byteLength(s));
console.log("__byteLength: " + __byteLength(s));
console.log("ascii: " + Buffer.byteLength("plain"));
console.log("empty: " + Buffer.byteLength(""));
