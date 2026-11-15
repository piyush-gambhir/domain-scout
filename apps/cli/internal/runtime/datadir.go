package runtime

import (
	"errors"
	"path/filepath"
	"strings"
)

const ProtocolVersion = 1

const EnvDataDir = "DOMAIN_SCOUT_DATA_DIR"

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

		if v := getenv("XDG_DATA_HOME"); v != "" && strings.HasPrefix(v, "/") {
			return joinFor(goos, v, "domain-scout"), nil
		}
		if home == "" {
			return "", errors.New("cannot determine the home directory")
		}
		return joinFor(goos, home, ".local", "share", "domain-scout"), nil
	}
}

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
