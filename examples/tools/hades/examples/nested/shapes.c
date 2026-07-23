#include "shapes.h"
#include <math.h>
#include <string.h>

Shape make_triangle(const char *name, double cx, double cy, double r) {
    Shape s;
    memset(&s, 0, sizeof s);
    strncpy(s.name, name, sizeof s.name - 1);
    s.center = (Vec2){cx, cy};
    s.sides = 3;
    for (int i = 0; i < 3; i++) {
        double a = 2.0 * M_PI * i / 3.0;
        s.verts[i] = (Vec2){cx + r * cos(a), cy + r * sin(a)};   // bp: watch verts fill in
    }
    return s;
}

double perimeter(const Shape *s) {
    double sum = 0.0;
    for (int i = 0; i < s->sides; i++) {
        const Vec2 *a = &s->verts[i];
        const Vec2 *b = &s->verts[(i + 1) % s->sides];
        double dx = b->x - a->x, dy = b->y - a->y;
        sum += sqrt(dx * dx + dy * dy);                          // bp: nested ptr locals
    }
    return sum;
}
