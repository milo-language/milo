package main

import "fmt"

const N = 50000

func main() {
	m := make(map[int64]int64, N)
	for i := int64(0); i < N; i++ {
		m[i] = i * 2
	}
	var sum int64
	for i := int64(0); i < N; i++ {
		sum += m[i]
	}
	fmt.Printf("sum=%d\n", sum)
}
