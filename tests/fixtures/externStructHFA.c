// homogeneous float aggregates: SIMD-register passed on AAPCS64, SSE on SysV
typedef struct D2 { double x; double y; } D2;
typedef struct F4 { float a; float b; float c; float d; } F4;
double dot2(D2 p, D2 q) { return p.x * q.x + p.y * q.y; }
D2 scale2(D2 p, double k) { D2 r; r.x = p.x * k; r.y = p.y * k; return r; }
float sum4(F4 v) { return v.a + v.b + v.c + v.d; }
