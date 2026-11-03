// Shiki ships no MLIR grammar, and the dialect reference (mlir-tblgen output, included by
// mlir-dialect.md) is full of ```mlir fences. A small grammar covering MLIR's lexical
// classes (comments, strings, SSA values, block labels, symbols, types, attributes, op
// names) keeps docs.yml's "language not loaded" gate meaningful for real typos.
export const mlirGrammar = {
  name: 'mlir',
  scopeName: 'source.mlir',
  patterns: [
    { name: 'comment.line.double-slash.mlir', match: '//.*$' },
    { name: 'string.quoted.double.mlir', begin: '"', end: '"', patterns: [{ name: 'constant.character.escape.mlir', match: '\\\\.' }] },
    { name: 'variable.other.ssa.mlir', match: '%[\\w$.-]+(#\\d+)?' },
    { name: 'entity.name.label.mlir', match: '\\^[\\w$.-]+' },
    { name: 'entity.name.function.mlir', match: '@[\\w$.-]+' },
    { name: 'entity.name.type.mlir', match: '![\\w$.-]+' },
    { name: 'constant.other.attribute.mlir', match: '#[\\w$.-]+' },
    { name: 'storage.type.builtin.mlir', match: '\\b([su]?i\\d+|f(16|32|64|80|128)|bf16|index|none)\\b' },
    { name: 'constant.numeric.mlir', match: '\\b(0x[0-9a-fA-F]+|-?\\d+(\\.\\d+)?([eE][-+]?\\d+)?)\\b' },
    { name: 'keyword.control.op.mlir', match: '\\b[a-z_][\\w$]*\\.[\\w$.]+\\b' },
  ],
}
