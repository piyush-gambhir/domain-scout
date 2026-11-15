package main

import (
	"context"
	"os"
	"os/signal"
	"syscall"

	"github.com/piyush-gambhir/domain-scout/cli/internal/cli"
)

var version = "dev"

func main() {

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	code := cli.New(version).Run(ctx, os.Args[1:])
	stop()
	os.Exit(code)
}
