// minimal grep -c implementation for benchmarking
// reads whole file, scans line by line for substring, prints count
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>
#include <fcntl.h>

int main(int argc, char** argv) {
    if (argc < 3) { fprintf(stderr, "usage: grep <pattern> <file>\n"); return 2; }
    const char* pat = argv[1];
    int fd = open(argv[2], O_RDONLY);
    if (fd < 0) { perror("open"); return 1; }
    struct stat st;
    fstat(fd, &st);
    char* buf = malloc(st.st_size + 1);
    ssize_t n = read(fd, buf, st.st_size);
    buf[n] = 0;
    close(fd);
    size_t patlen = strlen(pat);
    long count = 0;
    char* line = buf;
    for (ssize_t i = 0; i <= n; i++) {
        if (i == n || buf[i] == '\n') {
            buf[i] = 0;
            if (strstr(line, pat)) count++;
            line = buf + i + 1;
        }
    }
    printf("%ld\n", count);
    free(buf);
    return count > 0 ? 0 : 1;
}
