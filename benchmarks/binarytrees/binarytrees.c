// allocation-heavy: build/walk full binary trees
#include <stdio.h>
#include <stdlib.h>

typedef struct Node { struct Node *l, *r; } Node;

Node* make_tree(int d) {
    Node *n = malloc(sizeof(Node));
    if (d <= 0) { n->l = NULL; n->r = NULL; return n; }
    n->l = make_tree(d - 1);
    n->r = make_tree(d - 1);
    return n;
}

int check(Node *n) {
    if (!n->l) return 1;
    return 1 + check(n->l) + check(n->r);
}

void free_tree(Node *n) {
    if (!n) return;
    free_tree(n->l); free_tree(n->r); free(n);
}

int main(void) {
    int depth = 15;
    Node *t = make_tree(depth);
    int c = check(t);
    free_tree(t);
    printf("depth %d check=%d\n", depth, c);
    return 0;
}
