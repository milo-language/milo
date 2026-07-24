# std/zstd

## std/zstd

### `bcAdd`

```milo
fn bcAdd(b: &mut BitCS, value: i64, n: i64)
```

_Undocumented._

### `bcAlign`

```milo
fn bcAlign(b: &mut BitCS)
```

Byte-align a forward bitstream (the FSE distribution header) with no padding marker.

### `bcClose`

```milo
fn bcClose(b: &mut BitCS)
```

Append the '1' padding marker (so the last non-zero byte's top set bit locates the
stream end) and byte-align.

### `cloneFse`

```milo
fn cloneFse(t: &FseTable): FseTable
```

_Undocumented._

### `cloneHuf`

```milo
fn cloneHuf(t: &HufTable): HufTable
```

_Undocumented._

### `compressBlock`

```milo
fn compressBlock(block: &string): BlockResult
```

Compress one block into a Compressed_Block body: Raw literals + FSE-coded sequences,
each of the three code streams using a Predefined or custom (mode-2) FSE table, whichever
the plan picks. `ok == false` when the block yields no sequences — the caller emits Raw.

### `computeCodes`

```milo
fn computeCodes(seqs: &Vec<Seq3>): SeqCodes
```

_Undocumented._

### `computeOffset`

```milo
fn computeOffset(rawOffset: i64, litLen: i64, hist: &mut Vec<i64>): i64
```

Resolve the raw offset value against the three repeat offsets (RFC 8878 §3.1.1.5),
mutating the history. Returns the actual back-distance.

### `decodeHufTable`

```milo
fn decodeHufTable(hufData: &string): HufTableResult
```

Decode the Huffman table description at the start of the literals payload.

### `decompressCompressed`

```milo
fn decompressCompressed(src: &string, blockStart: i64, blockSize: i64, out: &mut string, st: &mut ZDec): i64
```

Decode a single Compressed_Block (RFC 8878 §3.1.1.2) into `out`. Handles Raw/RLE and
Huffman (own-tree + Treeless) literals, and Predefined/RLE/FSE/Repeat sequence tables,
persisting reusable tables into `st` for later blocks in the frame.

### `dummyHuf`

```milo
fn dummyHuf(): HufTable
```

_Undocumented._

### `emitLE`

```milo
fn emitLE(out: &mut string, value: i64, nbytes: i64)
```

_Undocumented._

### `enc32LE`

```milo
fn enc32LE(out: &mut string, v: i64)
```

_Undocumented._

### `encBlockHeader`

```milo
fn encBlockHeader(out: &mut string, size: i64, blockType: i64, last: bool)
```

3-byte block header (LE): last-block flag, block type, block size.

### `encodeLiterals`

```milo
fn encodeLiterals(literals: &string): string
```

Encode the literals section, choosing Huffman when it shrinks below Raw.

### `encodeOffsetBase`

```milo
fn encodeOffsetBase(offset: i64, litLen: i64, rep: &mut Vec<i64>): i64
```

Choose the offBase (raw offset code) for a sequence, preferring a repeat-offset code
(1/2/3, coded in 0–1 offset bits) when the actual back-distance matches recent history
over a full offset+3 code. The exact inverse of the decoder's `_computeOffset`; advancing
`rep` through the same call keeps encoder and decoder repeat histories in lockstep by
construction. Cheapest match wins.

### `encRawBlockHeader`

```milo
fn encRawBlockHeader(out: &mut string, size: i64, last: bool)
```

Emit a Raw block header (3 bytes LE): last-block flag, type 0, block size.

### `encRawLiteralsHeader`

```milo
fn encRawLiteralsHeader(out: &mut string, size: i64)
```

Raw literals section header (RFC 8878 §3.1.1.3.1.1): 1/2/3-byte forms by size.

### `encSeqBitstream`

```milo
fn encSeqBitstream(c: &SeqCodes, llCT: &FseCTable, ofCT: &FseCTable, mlCT: &FseCTable): string
```

Encode the sequence section's interleaved FSE bitstream. Write order mirrors zstd's
`ZSTD_encodeSequences` so the decoder's backward reader inverts it exactly. The three
CTables may be Predefined- or custom-built; the bitstream shape is identical either way.

### `encSeqCount`

```milo
fn encSeqCount(out: &mut string, n: i64)
```

Number_of_Sequences varint (RFC 8878 §3.1.1.3.2.1).

### `fseBuild`

```milo
fn fseBuild(dist: &Vec<i64>, accuracyLog: i64): FseTable
```

Build an FSE decoding table from a normalized distribution (RFC 8878 §4.1.1).
`dist[s] == -1` marks a "less than 1" probability symbol given a single high cell.

### `fseBuildCTable`

```milo
fn fseBuildCTable(dist: Vec<i64>, accuracyLog: i64): FseCTable
```

Build the FSE encode table from a normalized distribution — the inverse of the decoder's
`_fseBuild`. `dist[s] == -1` is a "less than one" symbol (a single high cell), same
convention as the decoder. Symbol spread is byte-identical to `_fseBuild` so encoder and
decoder agree on which state emits which symbol.

### `fseBuildRle`

```milo
fn fseBuildRle(symb: i64): FseTable
```

Single-symbol (RLE) table: every state decodes `symb`, consuming no bits.

### `fseDecodeHeader`

```milo
fn fseDecodeHeader(src: &string, base: i64, maxAccuracy: i64): FseHdr
```

Decode an FSE distribution table from the forward bitstream at byte `base`
(RFC 8878 §4.1.1). Reads probabilities LSB-first, then byte-aligns.

### `fseDecompressInterleaved2`

```milo
fn fseDecompressInterleaved2(t: &FseTable, stream: &string): Vec<i64>
```

FSE decode with two interleaved states (used only for Huffman weights).

### `fseEncodeSymbol`

```milo
fn fseEncodeSymbol(b: &mut BitCS, ct: &FseCTable, value: i64, symbol: i64): i64
```

Encode one symbol: write the low nbBitsOut bits of the current state, then transition.

### `fseInitCState2`

```milo
fn fseInitCState2(ct: &FseCTable, symbol: i64): i64
```

Initial encoder state for the first-encoded symbol (the last sequence, since encoding
runs backward). No bits are written; this state is flushed at the end.

### `fseInitState`

```milo
fn fseInitState(t: &FseTable, src: &string, r: &mut Rev): i64
```

_Undocumented._

### `fseNormalizeCount`

```milo
fn fseNormalizeCount(counts: &Vec<i64>, total: i64, maxSymbol: i64, tableLog: i64): Vec<i64>
```

Normalize a symbol histogram to a distribution summing to 2^tableLog, giving every
present symbol at least 1 (we never emit -1 low-prob cells: our alphabets are far
smaller than the table, so min-1 always fits). The remainder lands on the most frequent
symbol; a steal loop keeps the total exact even if min-1 rounding overshoots. Need not
match zstd's optimal normalization — the decoder reads whatever header we write.

### `fseUpdate`

```milo
fn fseUpdate(t: &FseTable, state: i64, src: &string, r: &mut Rev): i64
```

_Undocumented._

### `fseWriteNCount`

```milo
fn fseWriteNCount(dist: &Vec<i64>, tableLog: i64, maxSymbol: i64): string
```

Write an FSE distribution header (RFC 8878 §4.1.1) — the exact inverse of the decoder's
`_fseDecodeHeader`. Probabilities are coded LSB-first with the low-value shortcut (a
value in the lower part of the range costs one fewer bit) and 2-bit zero-run flags; the
header is byte-aligned at the end. Follows zstd's FSE_writeNCount arithmetic.

### `highestSetBit`

```milo
fn highestSetBit(n: i64): i64
```

Index of the highest set bit of n (n > 0), else -1. Loop-shift form avoids the
1<<63 overflow trap a bit-probe would hit.

### `hufBuildCodes`

```milo
fn hufBuildCodes(codeLen: &Vec<i64>, numSymbs: i64, maxBits: i64): Vec<i64>
```

Assign canonical Huffman codes from code lengths, byte-identical to the decoder's
`_hufBuildFromBits` table layout (longest codes at the low table indices, symbol order
within a length). Returns each symbol's `codeLen`-bit code, MSB-first.

### `hufBuildFromBits`

```milo
fn hufBuildFromBits(bits: &Vec<i64>, numSymbs: i64): HufTable
```

Build a Huffman decode table from per-symbol bit lengths (RFC 8878 §4.2.1).

### `hufBuildFromWeights`

```milo
fn hufBuildFromWeights(weights: &Vec<i64>, numSymbs: i64): HufTable
```

Build a Huffman table from transmitted weights; the final symbol's weight is
inferred so the implied code lengths complete a full tree (RFC 8878 §4.2.1.1).

### `hufCodeLengths`

```milo
fn hufCodeLengths(freq: &Vec<i64>, maxSymbol: i64): Vec<i64>
```

Plain Huffman code lengths from a symbol histogram (0 = symbol absent). Repeated
merge-two-smallest over ≤129 symbols, then each leaf's length is its depth to the root.

### `hufDecode1Stream`

```milo
fn hufDecode1Stream(t: &HufTable, stream: &string): string
```

Decode one Huffman-coded stream (read backward) to bytes.

### `hufEncode1Stream`

```milo
fn hufEncode1Stream(literals: &string, from: i64, to: i64, hufCode: &Vec<i64>, hufLen: &Vec<i64>): string
```

Huffman-code `literals[from..to)` into one backward bitstream (the inverse of
`_hufDecode1Stream`): symbols written last-first, each code appended MSB-aligned, then a
'1' padding marker + byte-align. The decoder's window reader recovers them in order.

### `hufLiteralsSection`

```milo
fn hufLiteralsSection(literals: &string): string
```

Build a full Huffman literals section, or "" if Huffman isn't viable (tiny input, alphabet
past symbol 128, tree deeper than 11 bits, or the size field can't hold the result).

### `leN`

```milo
fn leN(src: &string, pos: i64, n: i64): i64
```

Read a little-endian unsigned integer of `n` bytes (n in 1..8) at `pos`.

### `llBaselines`

```milo
fn llBaselines(): Vec<i64>
```

Baselines + extra-bit counts for literal-length and match-length codes.

### `llCodeTable`

```milo
fn llCodeTable(): Vec<i64>
```

Literal-length code table (values 0..63; larger use highbit+19). RFC 8878 §3.1.1.3.2.1.1.

### `llDefaultDist`

```milo
fn llDefaultDist(): Vec<i64>
```

Predefined distributions (RFC 8878 §3.1.1.3.2.2.1) — used when a sequence's
compression mode is Predefined. Accuracy logs: LL 6, OF 5, ML 6.

### `llExtraBits`

```milo
fn llExtraBits(): Vec<i64>
```

_Undocumented._

### `lz77`

```milo
fn lz77(block: &string): LzResult
```

Greedy hash-chain LZ77 over a single block. Matches stay within the block (offset ≤
current position), min match 3. A modest chain cap keeps it near-linear; ratio, not
optimality, is the milestone-1 goal.

### `mlBaselines`

```milo
fn mlBaselines(): Vec<i64>
```

_Undocumented._

### `mlCodeTable`

```milo
fn mlCodeTable(): Vec<i64>
```

Match-length code table, indexed by (matchLen - 3); larger use highbit+36.

### `mlDefaultDist`

```milo
fn mlDefaultDist(): Vec<i64>
```

_Undocumented._

### `mlExtraBits`

```milo
fn mlExtraBits(): Vec<i64>
```

_Undocumented._

### `ofDefaultDist`

```milo
fn ofDefaultDist(): Vec<i64>
```

_Undocumented._

### `parseHeader`

```milo
fn parseHeader(src: &string): ZstdHeader
```

Parse the frame header. Returns headerLen < 0 on malformed input.

### `planStream`

```milo
fn planStream(codes: &Vec<i64>, predefDist: Vec<i64>, predefLog: i64, maxAcc: i64): StreamPlan
```

Pick Predefined vs a custom FSE table for one code stream and build the encode table.
Custom tables cost a header, so we only take them once there are enough sequences to
amortize it and the stream actually has ≥2 distinct symbols.

### `rawLiteralsSection`

```milo
fn rawLiteralsSection(literals: &string): string
```

Raw literals section (header + bytes), the never-expands fallback.

### `readBitsLE`

```milo
fn readBitsLE(src: &string, numBits: i64, offset: i64): i64
```

Forward little-endian bit read of `numBits` bits at bit-offset `offset`.

### `slice`

```milo
pub fn slice(src: &string, from: i64, to: i64): string
```

Extract src[from .. to) into an owned string.

### `streamRead`

```milo
fn streamRead(src: &string, bits: i64, r: &mut Rev): i64
```

Pull `bits` bits from the current position, moving backward. Bits that fall before
the start of the stream are filled with zeros (RFC-mandated padding behaviour).

### `zeroVec`

```milo
fn zeroVec(n: i64): Vec<i64>
```

_Undocumented._

### `zstdCompress`

```milo
pub fn zstdCompress(src: &string): string
```

Compress `src` to a real zstd frame: greedy LZ77 + FSE-coded sequences (Predefined or
custom per-block tables), repeat-offset codes for recurring back-distances, and Huffman-
coded literals (litType 2, ASCII/text; Raw for wider alphabets), with a per-block Raw
fallback so output never expands. Single-segment header with a 4-byte content size and an
appended XXH64 content checksum — decodable by `zstdDecompress` above and reference `zstd -d`.

### `zstdCompressRaw`

```milo
pub fn zstdCompressRaw(src: &string): string
```

Encode `src` as a zstd frame of Raw blocks (RFC 8878). No entropy stage — this is
valid, `zstd -d`-decodable output at zero compression; the compressing path (LZ77 +
FSE-coded sequences) builds on this frame scaffolding. Single-segment header carries
the content size, and an XXH64 content checksum is appended.

### `zstdDecompress`

```milo
pub fn zstdDecompress(src: &string): Result<string, string>
```

Decompress a single zstd frame. Multi-frame concatenation is not handled — one
frame per call, like `zstd`'s default single-frame output.
