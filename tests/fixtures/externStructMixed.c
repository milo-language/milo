// mixed int/float structs: SysV classifies per-eightbyte (SSE vs INTEGER)
typedef struct M1 { double d; long i; } M1;   // eightbyte0 SSE, eightbyte1 INTEGER
typedef struct M2 { int i; float f; } M2;      // one mixed eightbyte → INTEGER
double m1_use(M1 m) { return m.d + (double)m.i; }
M1 m1_make(double d, long i) { M1 r; r.d = d; r.i = i; return r; }
float m2_use(M2 m) { return (float)m.i + m.f; }
