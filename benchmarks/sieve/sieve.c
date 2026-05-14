#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LIMIT 10000000

int main(void) {
    char *flags = (char *)malloc(LIMIT + 1);
    memset(flags, 1, LIMIT + 1);
    flags[0] = 0;
    flags[1] = 0;
    for (long p = 2; p * p <= LIMIT; p++) {
        if (flags[p]) {
            for (long m = p * p; m <= LIMIT; m += p) {
                flags[m] = 0;
            }
        }
    }
    int count = 0;
    for (int i = 0; i <= LIMIT; i++) {
        if (flags[i]) count++;
    }
    printf("primes <= %d: %d\n", LIMIT, count);
    free(flags);
    return 0;
}
