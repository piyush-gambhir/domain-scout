// Package runtime implements the client side of the local runtime protocol
// (docs/IMPLEMENTATION.md "Local runtime protocol"): data directory resolution,
// runtime files and backend identity verification.
package runtime

import (
	"errors"
	"path/filepath"
	"strings"
)

// ProtocolVersion is the runtime handshake version this CLI speaks.
const ProtocolVersion = 1

// EnvDataDir overrides the default data directory.
const EnvDataDir = "DOMAIN_SCOUT_DATA_DIR"

// DefaultDataDir returns the per-user application data directory for goos.
// It is a pure function so every platform can be tested from any host:
// Windows paths use backslashes, everything else forward slashes.
func DefaultDataDir(goos string, getenv func(string) string, home string) (string, error) {
	switch goos {
	case "darwin":
		if home == "" {
			return "", errors.New("cannot determine the home directory")
		}
		return joinFor(goos, home, "Library", "Application Support", "Domain Scout"), nil
	case "windows":
		if v := getenv("LOCALAPPDATA"); v != "" {
			return joinFor(goos, v, "Domain Scout"), nil
		}
		if home == "" {
			return "", errors.New("LOCALAPPDATA is not set and the home directory is unknown")
		}
		return joinFor(goos, home, "AppData", "Local", "Domain Scout"), nil
	default:
		// XDG requires an absolute path; relative values are ignored.
		if v := getenv("XDG_DATA_HOME"); v != "" && strings.HasPrefix(v, "/") {
			return joinFor(goos, v, "domain-scout"), nil
		}
		if home == "" {
			return "", errors.New("cannot determine the home directory")
		}
		return joinFor(goos, home, ".local", "share", "domain-scout"), nil
	}
}

// ResolveDataDir applies the precedence --data-dir flag, then
// DOMAIN_SCOUT_DATA_DIR, then the OS default. Explicit values are made absolute.
func ResolveDataDir(flag string, goos string, getenv func(string) string, home string) (string, error) {
	if flag != "" {
		return filepath.Abs(flag)
	}
	if v := getenv(EnvDataDir); v != "" {
		return filepath.Abs(v)
	}
	return DefaultDataDir(goos, getenv, home)
}

func joinFor(goos string, elems ...string) string {
	sep := "/"
	if goos == "windows" {
		sep = `\`
	}
	out := strings.TrimRight(elems[0], `/\`)
	for _, e := range elems[1:] {
		out += sep + e
	}
	return out
}
