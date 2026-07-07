// struct with a pointer field must survive register coercion with pointer bits intact
typedef struct Span { char* ptr; long len; } Span;
static char BUF[4] = { 65, 66, 67, 0 };
Span make_span(void) { Span s; s.ptr = BUF; s.len = 3; return s; }
long span_len(Span s) { return s.len; }
int span_first(Span s) { return (int)(unsigned char)s.ptr[0]; }
