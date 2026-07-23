#include "shapes.h"
#include <stdio.h>
#include <stdlib.h>

static Node *push(Node *head, int val) {
    Node *n = malloc(sizeof(Node));
    n->val = val;
    n->next = head;
    return n;
}

int main(void) {
    Shape shapes[2];
    shapes[0] = make_triangle("alpha", 0.0, 0.0, 1.0);
    shapes[1] = make_triangle("beta", 5.0, 5.0, 2.0);

    Node *list = 0;
    for (int i = 1; i <= 4; i++) list = push(list, i * i);       // bp: expand list->next->next

    double total = 0.0;
    for (int i = 0; i < 2; i++) {
        double p = perimeter(&shapes[i]);
        printf("%s perimeter=%.3f\n", shapes[i].name, p);        // bp: shapes[i] nested view
        total += p;
    }
    printf("total=%.3f list head=%d\n", total, list->val);
    return 0;
}
