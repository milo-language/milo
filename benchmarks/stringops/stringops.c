// concat 100k chunks into a single string
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#define N 100000
int main(void) {
    char* chunk = "the quick brown fox jumps over the lazy dog";
    size_t clen = strlen(chunk);
    size_t cap = 64, len = 0;
    char* buf = malloc(cap);
    buf[0] = 0;
    for (int i = 0; i < N; i++) {
        if (len + clen + 1 > cap) {
            while (len + clen + 1 > cap) cap *= 2;
            buf = realloc(buf, cap);
        }
        memcpy(buf + len, chunk, clen);
        len += clen;
        buf[len] = 0;
    }
    printf("len=%zu\n", len);
    free(buf);
    return 0;
}
