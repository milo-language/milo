// C ABI peer for externStructNested.milo — reports the C compiler's own
// sizeof/offsetof so Milo's manual layout can be checked against ground truth.
#include <stddef.h>

typedef struct Inner { int a; int b; int c; } Inner;        // 12 bytes, align 4
typedef struct Outer { int tag; Inner inner; } Outer;       // inner @4, size 16
typedef struct WithArr { int x; int arr[3]; } WithArr;      // arr @4, size 16

long c_sizeof_inner(void)   { return (long)sizeof(Inner); }
long c_sizeof_outer(void)   { return (long)sizeof(Outer); }
long c_offset_inner(void)   { return (long)offsetof(Outer, inner); }
long c_sizeof_witharr(void) { return (long)sizeof(WithArr); }
long c_offset_arr(void)     { return (long)offsetof(WithArr, arr); }
