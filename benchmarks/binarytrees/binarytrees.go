package main

import "fmt"

type Node struct {
	l, r *Node
}

func makeTree(d int) *Node {
	if d <= 0 {
		return &Node{}
	}
	return &Node{makeTree(d - 1), makeTree(d - 1)}
}

func check(n *Node) int {
	if n.l == nil {
		return 1
	}
	return 1 + check(n.l) + check(n.r)
}

func main() {
	depth := 18
	t := makeTree(depth)
	c := check(t)
	fmt.Printf("depth %d check=%d\n", depth, c)
}
