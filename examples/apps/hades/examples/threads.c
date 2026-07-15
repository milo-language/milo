// Multithreaded debuggee for the threads panel (M8l).
// Break at `go = 0;` (line 25): main is stopped with 3 workers alive in
// their loops — deterministic 4-thread stop.
#include <pthread.h>
#include <stdio.h>
#include <unistd.h>

static volatile int go = 1;

static void *worker(void *arg) {
    long id = (long)arg;
    long acc = 0;
    while (go) {
        acc += id;
        usleep(1000);
    }
    printf("worker %ld acc=%ld\n", id, acc);
    return (void *)acc;
}

int main(void) {
    pthread_t t[3];
    for (long i = 0; i < 3; i++) pthread_create(&t[i], 0, worker, (void *)(i + 1));
    usleep(50000);
    go = 0;
    for (int i = 0; i < 3; i++) pthread_join(t[i], 0);
    puts("done");
    return 0;
}
