const order = [];
Promise.resolve("r").then((v) => order.push("then:" + v));
Promise.reject(new Error("x")).catch((e) => order.push("catch:" + e.message));
Promise.all([1, Promise.resolve(2)]).then((v) => order.push("all:" + v.join(",")));
Promise.race([new Promise((r) => setTimeout(() => r("slow"), 20)), Promise.resolve("fast")]).then((v) => order.push("race:" + v));
Promise.allSettled([Promise.resolve(1), Promise.reject(new Error("no"))]).then((rs) => order.push("settled:" + rs.map((r) => r.status).join(",")));
setTimeout(() => console.log(order.join(" | ")), 50);
