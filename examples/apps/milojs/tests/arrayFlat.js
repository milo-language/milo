console.log(JSON.stringify([1, [2, [3]]].flat()));
console.log(JSON.stringify([1, [2, [3, [4]]]].flat(2)));
console.log(JSON.stringify([1, [2, [3, [4]]]].flat(Infinity)));
console.log(JSON.stringify([1, [2], 3].flat(0)));
console.log(JSON.stringify([].flat()));
console.log(JSON.stringify([1, [2, 3], [4, [5]]].flat()));
