package main

import (
	"encoding/json"
	"fmt"
	"os"
)

type Item struct {
	ID     int      `json:"id"`
	Name   string   `json:"name"`
	Price  float64  `json:"price"`
	Tags   []string `json:"tags"`
	Active bool     `json:"active"`
}

type Doc struct {
	Items []Item `json:"items"`
}

func main() {
	if len(os.Args) < 2 {
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		os.Exit(1)
	}
	var d Doc
	if err := json.Unmarshal(data, &d); err != nil {
		os.Exit(1)
	}
	sum := 0.0
	active := 0
	for _, it := range d.Items {
		sum += it.Price
		if it.Active {
			active++
		}
	}
	fmt.Printf("items=%d sum=%.2f active=%d\n", len(d.Items), sum, active)
}
