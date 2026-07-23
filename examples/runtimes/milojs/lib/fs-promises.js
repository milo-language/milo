// node:fs/promises — the same surface as fs.promises, exposed as its own module.
// Prisma's client imports it directly rather than reaching through fs.
module.exports = require("fs").promises;
