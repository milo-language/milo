// The std/hashmap intrinsics: FNV-1a hashing and key equality (_mapHash, _mapKeyEq), the
// structural copy of a stored value (_mapCopyOut), the seed source (_mapSeed) and the
// checked slot allocation (_mapAlloc). Every HashMap method body is Milo code in
// std/hashmap.milo; for-in, drop, display and the deep clone stay in codegen.ts and its
// siblings. std/set's HashSet is a HashMap<T, bool> underneath, so sets hash through here.

// Field count of %HashMap, and the single source for its size. Every field is 8 bytes
// (one ptr + four i64), so the size is just the count — but the COUNT has to come from
// one place or the two drift, which is exactly what happened.
export const HASHMAP_FIELDS = 5;

// The hash seed source: codegen.ts defines it (record/replay fixes its sequence), and
// std/hashmap's insert calls it through _mapSeed on a map's first insert.
export const HASH_SEED_FN = "__milo_hash_seed";
