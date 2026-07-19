// node-fetch — thin re-export of the global fetch/Headers/Request/Response the
// prelude installs (backed by the __httpFetch native). Kept as a module so
// bundles that `require('node-fetch')` get the same implementation as the global.

module.exports = fetch;
module.exports.default = fetch;
module.exports.Headers = Headers;
module.exports.Request = Request;
module.exports.Response = Response;
module.exports.FetchError = Error;
module.exports.AbortController = AbortController;
