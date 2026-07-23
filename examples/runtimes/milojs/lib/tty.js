// node:tty — milojs has no terminal handles, so nothing is a TTY. Packages use
// this only to decide whether to colourise output.
exports.isatty = function () { return false; };
function ReadStream() {}
function WriteStream() {}
exports.ReadStream = ReadStream;
exports.WriteStream = WriteStream;
