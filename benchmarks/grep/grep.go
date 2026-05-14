// minimal grep -c implementation for benchmarking
package main

import (
	"bytes"
	"fmt"
	"os"
)

func main() {
	if len(os.Args) < 3 {
		fmt.Fprintln(os.Stderr, "usage: grep <pattern> <file>")
		os.Exit(2)
	}
	pat := []byte(os.Args[1])
	data, err := os.ReadFile(os.Args[2])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	count := 0
	for _, line := range bytes.Split(data, []byte("\n")) {
		if bytes.Contains(line, pat) {
			count++
		}
	}
	fmt.Println(count)
	if count == 0 {
		os.Exit(1)
	}
}
