// nested all-float struct flattens to a 3-member HFA ([3 x float] on AAPCS64)
typedef struct P2 { float x; float y; } P2;
typedef struct Tri { P2 base; float z; } Tri;
float tri_sum(Tri t) { return t.base.x + t.base.y + t.z; }
Tri tri_scale(Tri t, float k) { Tri r; r.base.x = t.base.x*k; r.base.y = t.base.y*k; r.z = t.z*k; return r; }
