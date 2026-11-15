package main

import (
	"flag"
	"go/format"
	"go/scanner"
	"go/token"
	"os"
	"strings"
)

func main() {
	path := flag.String("file", "", "generated Go file")
	flag.Parse()
	source, err := os.ReadFile(*path)
	if err != nil {
		panic(err)
	}
	file := token.NewFileSet().AddFile(*path, -1, len(source))
	var scan scanner.Scanner
	scan.Init(file, source, nil, scanner.ScanComments)
	for {
		pos, kind, text := scan.Scan()
		if kind == token.EOF {
			break
		}
		if kind != token.COMMENT || strings.HasPrefix(text, "// Code generated ") {
			continue
		}
		start := file.Offset(pos)
		for i := start; i < start+len(text); i++ {
			if source[i] != '\n' && source[i] != '\r' {
				source[i] = ' '
			}
		}
	}
	output, err := format.Source(source)
	if err != nil {
		panic(err)
	}
	if err := os.WriteFile(*path, output, 0644); err != nil {
		panic(err)
	}
}
