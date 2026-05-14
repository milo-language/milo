package main

import (
	"fmt"
	"strings"
)

const N = 100000

func main() {
	chunk := "the quick brown fox jumps over the lazy dog"
	var b strings.Builder
	for i := 0; i < N; i++ {
		b.WriteString(chunk)
	}
	fmt.Printf("len=%d\n", b.Len())
}
