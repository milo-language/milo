package main

import "fmt"

const LIMIT = 10000000

func main() {
	flags := make([]bool, LIMIT+1)
	for i := range flags {
		flags[i] = true
	}
	flags[0] = false
	flags[1] = false
	for p := 2; p*p <= LIMIT; p++ {
		if flags[p] {
			for m := p * p; m <= LIMIT; m += p {
				flags[m] = false
			}
		}
	}
	count := 0
	for i := 0; i <= LIMIT; i++ {
		if flags[i] {
			count++
		}
	}
	fmt.Printf("primes <= %d: %d\n", LIMIT, count)
}
