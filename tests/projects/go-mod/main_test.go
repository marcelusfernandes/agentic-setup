package main

import "testing"

func TestMainOk(t *testing.T) {
	if 1+1 != 2 {
		t.Fatal("math is broken")
	}
}
