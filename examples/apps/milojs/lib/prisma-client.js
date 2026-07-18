// @prisma/client — unreachable, not merely unimplemented.
//
// The real client dlopens a native napi query engine, so no amount of JS-engine
// work can run it. This stub lets a bundle that imports Prisma load and start;
// any actual query rejects, so DB-backed routes fail loudly instead of silently
// returning wrong data.

function notAvailable(op) {
  return Promise.reject(new Error(
    'PrismaClient is not available under milojs: it loads a native query engine. ' +
    'Attempted: ' + op
  ));
}

function modelProxy(name) {
  var model = {};
  var ops = ['findUnique', 'findUniqueOrThrow', 'findFirst', 'findFirstOrThrow', 'findMany',
             'create', 'createMany', 'update', 'updateMany', 'upsert', 'delete', 'deleteMany',
             'count', 'aggregate', 'groupBy'];
  for (var i = 0; i < ops.length; i++) {
    (function (op) {
      model[op] = function () { return notAvailable(name + '.' + op); };
    })(ops[i]);
  }
  return model;
}

function PrismaClient(options) {
  if (!(this instanceof PrismaClient)) return new PrismaClient(options);
  this.$connect = function () { return notAvailable('$connect'); };
  this.$disconnect = function () { return Promise.resolve(); };
  this.$on = function () { return this; };
  this.$transaction = function () { return notAvailable('$transaction'); };
  this.$queryRaw = function () { return notAvailable('$queryRaw'); };
  this.$executeRaw = function () { return notAvailable('$executeRaw'); };
  this.$queryRawUnsafe = function () { return notAvailable('$queryRawUnsafe'); };
  this.$executeRawUnsafe = function () { return notAvailable('$executeRawUnsafe'); };
  this.$extends = function () { return this; };
}

exports.PrismaClient = PrismaClient;
exports.Prisma = {
  PrismaClientKnownRequestError: Error,
  PrismaClientUnknownRequestError: Error,
  PrismaClientValidationError: Error,
  sql: function () { return {}; },
  join: function () { return {}; },
  raw: function () { return {}; },
  empty: {}
};
exports.default = { PrismaClient: PrismaClient };
