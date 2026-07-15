// Debuggee for hades milestone 2: a breakpoint lands inside add(),
// where locals a, b, sum are live and inspectable via DAP.
#include <stdio.h>

int add(int a, int b) {
    int sum = a + b;   // <-- breakpoint here (line 6)
    return sum;
}

int main(void) {
    int x = 7;
    int y = 35;
    int r = add(x, y);
    printf("r=%d\n", r);
    return 0;
}
