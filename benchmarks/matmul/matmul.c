#include <stdio.h>
#include <stdlib.h>
#define N 256

int main(void) {
    double *a = malloc(N*N*sizeof(double));
    double *b = malloc(N*N*sizeof(double));
    double *c = calloc(N*N, sizeof(double));
    for (int i = 0; i < N*N; i++) { a[i] = (i % N) + 0.1; b[i] = (i / N) + 0.1; }
    for (int r = 0; r < N; r++)
        for (int col = 0; col < N; col++) {
            double s = 0.0;
            for (int k = 0; k < N; k++) s += a[r*N+k] * b[k*N+col];
            c[r*N+col] = s;
        }
    printf("c[0]=%.2f c[last]=%.2f\n", c[0], c[N*N-1]);
    free(a); free(b); free(c);
    return 0;
}
