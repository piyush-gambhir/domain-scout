package cli

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
)


const (
	ExitOK          = 0
	ExitFailure     = 1
	ExitUsage       = 2
	ExitUnresolved  = 3
	ExitAccess      = 4
	ExitSetup       = 5
	ExitInterrupted = 130
)


const ContractVersion = "1.0.0"


type exitError struct {
	code    int
	errCode api.ErrorCode
	msg     string
	raw     []byte
	parsed  *api.ErrorResponse
	note    bool


	retryable bool


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


var errInterrupted = &exitError{code: ExitInterrupted, errCode: api.ErrorCodeUnavailable, msg: "interrupted"}



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


func classify(err error) *exitError {
	var e *exitError
	if errors.As(err, &e) {
		return e
	}
	return &exitError{code: ExitFailure, errCode: api.ErrorCodeInternal, msg: err.Error()}
}



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
