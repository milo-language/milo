// two-eightbyte structs: {i64,i64}=16B and {i32,i32,i32}=12B both occupy 2 regs
// on SysV (i64,i64) and one [2 x i64] on AAPCS64.
typedef struct V2 { long a; long b; } V2;
typedef struct V3 { int a; int b; int c; } V3;
V2 v2_add(V2 p, V2 q) { V2 r; r.a = p.a + q.a; r.b = p.b + q.b; return r; }
long v3_sum(V3 v) { return (long)v.a + v.b + v.c; }
