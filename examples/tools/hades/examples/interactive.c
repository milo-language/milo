// Debuggee for hades milestone 4: reads stdin from the pty terminal while
// running, so the web terminal's keyboard path is exercised end to end.
#include <stdio.h>

int greet(char *name, int x, int y) {
    int sum = x + y;                 // <-- breakpoint here (line 6)
    printf("hello %s, sum=%d\n", name, sum);
    return sum;
}

int main(void) {
    char name[64];
    printf("who are you? ");
    fflush(stdout);
    if (scanf("%63s", name) != 1) return 1;
    int r = greet(name, 7, 35);
    printf("done r=%d\n", r);
    return 0;
}
