// Nested-data demo debuggee: structs in structs, arrays of structs, linked list.
#pragma once

typedef struct { double x, y; } Vec2;

typedef struct {
    char name[16];
    Vec2 center;
    Vec2 verts[3];
    int sides;
} Shape;

typedef struct Node {
    int val;
    struct Node *next;
} Node;

double perimeter(const Shape *s);
Shape make_triangle(const char *name, double cx, double cy, double r);
