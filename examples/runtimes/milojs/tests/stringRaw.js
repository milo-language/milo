console.log(String.raw`${1}+${2}=${3}`);
console.log(String.raw`plain text no holes`);
console.log(String.raw`a${"X"}b${"Y"}c`);
console.log(String.raw({ raw: ["a", "b", "c"] }, 1, 2));
console.log(String.raw({ raw: ["only"] }));
