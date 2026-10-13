// A getaddrinfo that only answers once two lookups are inside it at the same time (or
// after 3 s alone), then defers to libc's. Defined in the executable, it takes the
// place of libc's for every call std/net makes, which is what lets dnsParallel.milo
// observe whether two green tasks' lookups overlap.
#define _GNU_SOURCE
#include <dlfcn.h>
#include <netdb.h>
#include <pthread.h>
#include <sys/time.h>
#include <time.h>

static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int inside = 0, maxInside = 0;

typedef int (*gai_fn)(const char *, const char *, const struct addrinfo *, struct addrinfo **);

int getaddrinfo(const char *node, const char *service, const struct addrinfo *hints, struct addrinfo **res) {
    pthread_mutex_lock(&mu);
    inside++;
    if (inside > maxInside) maxInside = inside;
    pthread_cond_broadcast(&cv);
    struct timeval now;
    gettimeofday(&now, 0);
    struct timespec until = { now.tv_sec + 3, now.tv_usec * 1000 };
    while (maxInside < 2) {
        if (pthread_cond_timedwait(&cv, &mu, &until) != 0) break;
    }
    pthread_mutex_unlock(&mu);
    gai_fn real = (gai_fn)dlsym(RTLD_NEXT, "getaddrinfo");
    int r = real(node, service, hints, res);
    pthread_mutex_lock(&mu);
    inside--;
    pthread_mutex_unlock(&mu);
    return r;
}

int dnsMaxConcurrent(void) {
    pthread_mutex_lock(&mu);
    int m = maxInside;
    pthread_mutex_unlock(&mu);
    return m;
}
