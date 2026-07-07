// 24-byte struct: passed indirectly (ptr on AAPCS64, byval on SysV), returned via sret.
// bump mutates its OWN copy — the caller's original must be untouched.
typedef struct Big { long a; long b; long c; } Big;
Big bump(Big v) { v.a += 1000; v.b += 1000; v.c += 1000; return v; }
