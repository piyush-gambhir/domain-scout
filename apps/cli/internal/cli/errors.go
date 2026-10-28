package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
)

// Exit codes (docs/BUILD_HANDOFF.md "Go command contract").
const (
	ExitOK          = 0   // success or accepted submission
	ExitFailure     = 1   // local operation failure
	ExitUsage       = 2   // invalid request or usage (HTTP 400 too)
	ExitUnresolved  = 3   // job finished with unresolved items; results still printed
	ExitAccess      = 4   // required provider access missing
	ExitSetup       = 5   // backend setup or version failure
	ExitInterrupted = 130 // interrupted client wait
)

// ContractVersion is the API contract this client was generated from.
const ContractVersion = "1.0.0"

// exitError carries an exit code and what to print on stderr.
type exitError struct {
	code    int
	errCode api.ErrorCode // contract error code for locally produced errors
	msg     string
	raw     []byte // verbatim ErrorResponse from the API, when there is one
	parsed  *api.ErrorResponse
	note    bool // a plain stderr note rather than an error (exit 3 and 4 after printed results)
	// retryable marks connection failures that are safe to retry with the
	// same Idempotency-Key.
	retryable bool
	// gone marks a request the backend never handled because it had stopped
	// or was stopping; the client may start a new backend and resend it.
	gone bool
}

func (e *exitError) Error() string { return e.msg }

func usageErr(format string, args ...any) error {
	return &exitError{code: ExitUsage, errCode: api.ErrorCodeInvalidRequest, msg: fmt.Sprintf(format, args...)}
}

func failErr(format string, args ...any) error {
	return &exitError{code: ExitFailure, errCode: api.ErrorCodeInternal, msg: fmt.Sprintf(format, args...)}
}

func setupErr(format string, args ...any) error {
	return &exitError{code: ExitSetup, errCode: api.ErrorCodeUnavailable, msg: fmt.Sprintf(format, args...)}
}

// errInterrupted ends a wait on Ctrl-C; the job keeps running.
var errInterrupted = &exitError{code: ExitInterrupted, errCode: api.ErrorCodeUnavailable, msg: "interrupted"}

// apiError maps an HTTP error response to an exit code. The contract error
// code wins over the status: credential_required is always exit 4.
func apiError(status int, body []byte) error {
	var parsed api.ErrorResponse
	ok := json.Unmarshal(body, &parsed) == nil && parsed.Error.Code != ""
	e := &exitError{}
	if ok {
		e.parsed = &parsed
		e.raw = body
		e.errCode = parsed.Error.Code
		e.msg = parsed.Error.Message
	} else {
		e.errCode = codeForStatus(status)
		e.msg = fmt.Sprintf("backend returned HTTP %d", status)
		if s := strings.TrimSpace(string(body)); s != "" && len(s) < 300 {
			e.msg += ": " + s
		}
	}
	e.code = exitForAPIError(status, e.errCode)
	return e
}

func codeForStatus(status int) api.ErrorCode {
	switch status {
	case 400:
		return api.ErrorCodeInvalidRequest
	case 401:
		return api.ErrorCodeUnauthorized
	case 403:
		return api.ErrorCodeForbidden
	case 404:
		return api.ErrorCodeNotFound
	case 409:
		return api.ErrorCodeConflict
	case 503:
		return api.ErrorCodeUnavailable
	default:
		return api.ErrorCodeInternal
	}
}

func exitForAPIError(status int, code api.ErrorCode) int {
	switch code {
	case api.ErrorCodeCredentialRequired:
		return ExitAccess
	case api.ErrorCodeInvalidRequest, api.ErrorCodeIdempotencyConflict, api.ErrorCodeUnsupported:
		return ExitUsage
	case api.ErrorCodeUnauthorized, api.ErrorCodeForbidden:
		// The local token or runtime files do not match this backend.
		return ExitSetup
	}
	switch {
	case status == 400:
		return ExitUsage
	case status == 401 || status == 403:
		return ExitSetup
	default:
		return ExitFailure
	}
}

// classify converts any error into an exitError.
func classify(err error) *exitError {
	var e *exitError
	if errors.As(err, &e) {
		return e
	}
	return &exitError{code: ExitFailure, errCode: api.ErrorCodeInternal, msg: err.Error()}
}

// writeError prints err to stderr: the ErrorResponse JSON in machine output
// modes, a readable line in table mode.
func writeError(w io.Writer, mode string, e *exitError, quiet bool) {
	if e.note {
		if !quiet && e.msg != "" {
			fmt.Fprintln(w, e.msg)
		}
		return
	}
	if mode == outputTable {
		fmt.Fprintln(w, "error: "+humanError(e))
		return
	}
	if e.raw != nil {
		w.Write(e.raw)
		if len(e.raw) == 0 || e.raw[len(e.raw)-1] != '\n' {
			fmt.Fprintln(w)
		}
		return
	}
	b, _ := json.Marshal(localErrorEnvelope(e))
	fmt.Fprintln(w, string(b))
}

// localErrorEnvelope is the API ErrorResponse shape for errors raised in the CLI itself.
func localErrorEnvelope(e *exitError) map[string]any {
	return map[string]any{
		"contractVersion": ContractVersion,
		"error": map[string]any{
			"code":      e.errCode,
			"message":   e.msg,
			"requestId": "local",
			"domain":    nil,
			"source":    "cli",
			"retryable": false,
			"retryAt":   nil,
			"details":   nil,
		},
	}
}

func humanError(e *exitError) string {
	if e.parsed == nil {
		return e.msg
	}
	a := e.parsed.Error
	var b strings.Builder
	fmt.Fprintf(&b, "%s (%s)", a.Message, a.Code)
	if a.Domain != nil {
		fmt.Fprintf(&b, ", domain %s", *a.Domain)
	}
	if a.Source != nil {
		fmt.Fprintf(&b, ", source %s", *a.Source)
	}
	if a.Retryable {
		b.WriteString(", retryable")
		if a.RetryAt != nil {
			fmt.Fprintf(&b, " at %s", a.RetryAt.UTC().Format("2006-01-02T15:04:05Z"))
		}
	}
	if a.Details != nil {
		for _, d := range *a.Details {
			fmt.Fprintf(&b, "\n  %s: %s", d.Path, d.Message)
		}
	}
	if a.RequestId != "" {
		fmt.Fprintf(&b, " [request %s]", a.RequestId)
	}
	return b.String()
}
