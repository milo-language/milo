#include <stdio.h>
#include <stdlib.h>

#define N 500000

void quicksort(double *arr, int lo, int hi) {
    if (lo >= hi) return;
    double pivot = arr[hi];
    int i = lo;
    for (int j = lo; j < hi; j++) {
        if (arr[j] < pivot) {
            double tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
            i++;
        }
    }
    double tmp = arr[i];
    arr[i] = arr[hi];
    arr[hi] = tmp;
    quicksort(arr, lo, i - 1);
    quicksort(arr, i + 1, hi);
}

int main(void) {
    double *arr = (double *)malloc(N * sizeof(double));
    long seed = 42;
    for (int i = 0; i < N; i++) {
        seed = (seed * 16807) % 2147483647;
        arr[i] = (double)seed / 2147483647.0;
    }
    quicksort(arr, 0, N - 1);
    printf("first: %.6f\nlast: %.6f\n", arr[0], arr[N-1]);
    free(arr);
    return 0;
}
