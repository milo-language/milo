// {i32,i32} = 8 bytes: coerced to one integer register (both ABIs)
typedef struct P { int x; int y; } P;
P add_pts(P a, P b) { P r; r.x = a.x + b.x; r.y = a.y + b.y; return r; }
