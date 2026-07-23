// named capture groups (?<name>...): .groups on match/exec/matchAll + $<name>
const m = "2021-06-15".match(/(?<y>\d{4})-(?<mo>\d{2})-(?<d>\d{2})/);
console.log(m.groups.y, m.groups.mo, m.groups.d);
console.log(/(?<a>x)|(?<b>y)/.exec("y").groups.a, /(?<a>x)|(?<b>y)/.exec("y").groups.b);
console.log([...("a1b2".matchAll(/(?<L>[a-z])(?<N>\d)/g))].map(x=>x.groups.L+x.groups.N).join(","));
console.log("abc".match(/(a)(b)/).groups);
console.log("2021-06".replace(/(?<y>\d+)-(?<m>\d+)/, "$<m>/$<y>"));
console.log("John Smith".replace(/(?<first>\w+)\s(?<last>\w+)/, "$<last>, $<first>"));
