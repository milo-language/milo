// Vec method codegen helpers — extracted to keep codegen.ts manageable.













// Below this many live bytes a grow is malloc + memcpy + free rather than realloc. A
// small block cannot be remapped, so realloc saves no memory there, and macOS's realloc
// first looks the pointer's zone and size up: respond's string building (buffers of a
// few hundred bytes) ran 13% slower on realloc than on the copy. At a page and above
// the remap is what keeps peak RSS at the new size (vec_grow: 132 MB -> 68 MB).
export const REALLOC_MIN_BYTES = 4096;
