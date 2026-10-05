// Command domain-scout is the agent-first CLI for the local Domain Scout API.
package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/piyush-gambhir/domain-scout/cli/internal/cli"
)

// version is set at build time with -ldflags "-X main.version=<version>".
var version = "dev"

func main() {
	// Ctrl-C or SIGTERM ends a wait (exit 130); jobs keep running in the backend.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := cli.New(version).Run(ctx, os.Args[1:])
	stop()
	os.Exit(code)
}
