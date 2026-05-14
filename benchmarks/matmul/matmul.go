package main

import "fmt"

const N = 256

func main() {
	a := make([]float64, N*N)
	b := make([]float64, N*N)
	c := make([]float64, N*N)
	for i := 0; i < N*N; i++ {
		a[i] = float64(i%N) + 0.1
		b[i] = float64(i/N) + 0.1
	}
	for r := 0; r < N; r++ {
		for col := 0; col < N; col++ {
			s := 0.0
			for k := 0; k < N; k++ {
				s += a[r*N+k] * b[k*N+col]
			}
			c[r*N+col] = s
		}
	}
	fmt.Printf("c[0]=%.2f c[last]=%.2f\n", c[0], c[N*N-1])
}
