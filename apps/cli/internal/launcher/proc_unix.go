//go:build !windows

package launcher

import (
	"errors"
	"os/exec"
	"syscall"
)

// detach starts the child in its own session so terminal signals (Ctrl-C)
// and the CLI exiting do not stop it.
func detach(cmd *exec.Cmd) {
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true}
}

// ProcessAlive reports whether a process with pid exists.
func ProcessAlive(pid int) bool {
	if pid <= 0 {
		return false
	}
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
