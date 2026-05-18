package updateserver

import (
	"crypto/rand"
	"fmt"
)

const nanoIDAlphabet = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ_abcdefghijklmnopqrstuvwxyz-"

func randomID(size int) string {
	if size <= 0 {
		size = 21
	}
	buf := make([]byte, size)
	if _, err := rand.Read(buf); err != nil {
		panic(fmt.Errorf("generate id: %w", err))
	}
	out := make([]byte, size)
	for i, b := range buf {
		out[i] = nanoIDAlphabet[int(b)&63]
	}
	return string(out)
}
