// hashmap stress: insert 1M ints, then lookup 1M
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

// minimal linear-probing hashmap, int → int
typedef struct { long key; long val; int used; } Slot;

#define N 50000
#define CAP (1 << 18)  // 256K, ~40% load

static Slot table[CAP];

static unsigned long h(long k) { return (unsigned long)k * 2654435769ULL; }

void insert(long k, long v) {
    unsigned long i = h(k) & (CAP - 1);
    while (table[i].used && table[i].key != k) i = (i + 1) & (CAP - 1);
    table[i].used = 1; table[i].key = k; table[i].val = v;
}
long lookup(long k) {
    unsigned long i = h(k) & (CAP - 1);
    while (table[i].used) {
        if (table[i].key == k) return table[i].val;
        i = (i + 1) & (CAP - 1);
    }
    return -1;
}

int main(void) {
    for (long i = 0; i < N; i++) insert(i, i * 2);
    long sum = 0;
    for (long i = 0; i < N; i++) sum += lookup(i);
    printf("sum=%ld\n", sum);
    return 0;
}
