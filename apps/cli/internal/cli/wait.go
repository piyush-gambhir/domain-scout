package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
	"github.com/piyush-gambhir/domain-scout/cli/internal/sse"
)

func isTerminal(s api.JobState) bool {
	switch s {
	case api.JobStateCancelled, api.JobStateCompleted, api.JobStateCompletedWithErrors, api.JobStateInterrupted:
		return true
	}
	return false
}

// domainEvent is the DomainEvent envelope with the payload kept raw.
type domainEvent struct {
	ContractVersion string          `json:"contractVersion"`
	EventID         string          `json:"eventId"`
	Type            string          `json:"type"`
	OccurredAt      string          `json:"occurredAt"`
	JobID           *string         `json:"jobId"`
	WatchID         *string         `json:"watchId"`
	Payload         json.RawMessage `json:"payload"`
}

// waitHooks let callers observe a wait (jobs watch prints events).
type waitHooks struct {
	// onEvent receives every job event, including stream.reset.
	onEvent func(ev sse.Event) error
	// onPoll receives the job envelope when it changes in polling fallback.
	onPoll func(raw []byte) error
}

// streamIdleTimeout reconnects when not even a heartbeat arrives.
var streamIdleTimeout = 45 * time.Second

// waitJob observes a job until it reaches a terminal state. It prefers the
// event stream and falls back to polling. Ctrl-C returns errInterrupted; the
// job itself keeps running.
func (a *App) waitJob(ctx context.Context, c *apiClient, id api.Uuid, hooks waitHooks) (*api.Job, error) {
	jobID := id.String()
	pr := &progressReporter{app: a}
	var final *api.Job

	refetch := func() (bool, error) {
		job, _, err := c.getJob(ctx, id)
		if err != nil {
			return false, err
		}
		pr.job(job)
		if isTerminal(job.State) {
			final = job
			return true, nil
		}
		return false, nil
	}

	stream := &sse.Stream{
		Open:        c.openEvents(api.StreamEventsParams{JobId: &jobID}),
		IdleTimeout: streamIdleTimeout,
	}
	err := stream.Run(ctx, sse.Handlers{
		OnConnect: refetch,
		OnReset: func(ev sse.Event) (bool, error) {
			if hooks.onEvent != nil {
				if err := hooks.onEvent(ev); err != nil {
					return false, err
				}
			}
			return refetch()
		},
		OnEvent: func(ev sse.Event) (bool, error) {
			var de domainEvent
			if err := json.Unmarshal(ev.Data, &de); err != nil {
				return false, nil // not a DomainEvent; ignore
			}
			if de.JobID == nil || !strings.EqualFold(*de.JobID, jobID) {
				return false, nil
			}
			if hooks.onEvent != nil {
				if err := hooks.onEvent(ev); err != nil {
					return false, err
				}
			}
			switch de.Type {
			case "job.updated":
				var job api.Job
				if err := json.Unmarshal(de.Payload, &job); err != nil {
					return refetch()
				}
				pr.job(&job)
				if isTerminal(job.State) {
					final = &job
					return true, nil
				}
			case "job.progress":
				var p api.JobProgressPayload
				if json.Unmarshal(de.Payload, &p) == nil {
					pr.counters("", p.Counters)
				}
			}
			return false, nil
		},
	})
	switch {
	case err == nil:
		return final, nil
	case ctx.Err() != nil:
		return nil, errInterrupted
	case errors.Is(err, sse.ErrUnsupported), errors.Is(err, sse.ErrUnavailable):
		a.progress("Event stream unavailable (%v); polling job %s.", err, jobID)
		return a.pollJob(ctx, c, id, pr, hooks)
	default:
		return nil, err
	}
}

func (a *App) pollJob(ctx context.Context, c *apiClient, id api.Uuid, pr *progressReporter, hooks waitHooks) (*api.Job, error) {
	var lastUpdated time.Time
	for {
		job, raw, err := c.getJob(ctx, id)
		if err != nil {
			return nil, err
		}
		if hooks.onPoll != nil && !job.UpdatedAt.Equal(lastUpdated) {
			if err := hooks.onPoll(raw); err != nil {
				return nil, err
			}
		}
		lastUpdated = job.UpdatedAt
		pr.job(job)
		if isTerminal(job.State) {
			return job, nil
		}
		select {
		case <-ctx.Done():
			return nil, errInterrupted
		case <-time.After(a.pollInterval()):
		}
	}
}

// progressReporter writes throttled progress lines to stderr.
type progressReporter struct {
	app      *App
	state    string
	finished int
	last     time.Time
}

func (p *progressReporter) job(j *api.Job) {
	p.counters(string(j.State), j.Counters)
}

func (p *progressReporter) counters(state string, c api.JobCounters) {
	if state == "" {
		state = p.state
	}
	changed := state != p.state
	if !changed && (c.Finished == p.finished || time.Since(p.last) < time.Second) {
		return
	}
	p.state, p.finished, p.last = state, c.Finished, time.Now()
	p.app.progress("%s: %d/%d finished, %d unresolved", state, c.Finished, c.Total, c.Unresolved)
}

// accessOutcomes are item outcomes meaning provider access is missing or was
// rejected (the provider handlers' credential_required and credentials_invalid).
var accessOutcomes = []string{"credential_required", "credentials_invalid"}

// jobExit maps a finished job to the exit code contract. Missing or rejected
// provider access wins over unresolved items.
func jobExit(job *api.Job) error {
	var parts []string
	for _, outcome := range accessOutcomes {
		if n := job.Counters.Outcomes[outcome]; n > 0 {
			parts = append(parts, fmt.Sprintf("%d %s", n, outcome))
		}
	}
	if len(parts) > 0 {
		return &exitError{code: ExitAccess, note: true, msg: fmt.Sprintf(
			"job %s: item(s) finished %s. Configure or test the provider with 'domain-scout providers configure' and 'domain-scout providers test'.",
			job.Id, strings.Join(parts, ", "))}
	}
	switch job.State {
	case api.JobStateCompleted:
		return nil
	case api.JobStateCompletedWithErrors:
		return &exitError{code: ExitUnresolved, note: true, msg: fmt.Sprintf(
			"job %s completed with %d unresolved item(s).", job.Id, job.Counters.Unresolved)}
	default:
		unfinished := job.Counters.Total - job.Counters.Finished
		return &exitError{code: ExitUnresolved, note: true, msg: fmt.Sprintf(
			"job %s ended %s with %d unfinished and %d unresolved item(s). Resume with 'domain-scout jobs resume %s'.",
			job.Id, job.State, unfinished, job.Counters.Unresolved, job.Id)}
	}
}

// interruptedWait tells the user how to find the job again.
func (a *App) interruptedWait(id api.Uuid) error {
	fmt.Fprintf(a.Stderr, "Stopped waiting. Job %s keeps running; inspect it with 'domain-scout jobs show %s'.\n", id, id)
	return &exitError{code: ExitInterrupted, note: true}
}

// jobResults fetches every result page of a job as one envelope.
func (c *apiClient) jobResults(ctx context.Context, id api.Uuid, params api.ListJobResultsParams) ([]byte, error) {
	limit := 1000
	params.Limit = &limit
	return c.all(ctx, params.Cursor, func(cursor *string) callFn {
		p := params
		p.Cursor = cursor
		return func(ctx context.Context, g *api.Client) (*http.Response, error) {
			return g.ListJobResults(ctx, id, &p)
		}
	})
}

// submit sends a job-creating request that carries an Idempotency-Key, so
// connection failures are retried safely. Without wait it prints the job
// envelope (exit 0 confirms submission only). With wait it observes the job,
// prints all results and returns the job's exit code.
func (a *App) submit(ctx context.Context, wait bool, fn callFn) error {
	return a.submitWith(ctx, wait, true, fn)
}

// submitOnce is submit for operations without an Idempotency-Key; they are
// never retried automatically.
func (a *App) submitOnce(ctx context.Context, wait bool, fn callFn) error {
	return a.submitWith(ctx, wait, false, fn)
}

func (a *App) submitWith(ctx context.Context, wait, retry bool, fn callFn) error {
	c, err := a.api(ctx)
	if err != nil {
		return err
	}
	send := c.do
	if retry {
		send = c.doIdempotent
	}
	res, err := send(ctx, fn)
	if err != nil {
		return err
	}
	if !wait {
		return a.emit(res.body, jobView)
	}
	var jr api.JobResponse
	if err := json.Unmarshal(res.body, &jr); err != nil {
		return failErr("backend returned a malformed job: %v", err)
	}
	a.progress("Submitted job %s (%s).", jr.Data.Id, jr.Data.Type)
	return a.waitAndPrint(ctx, c, jr.Data.Id)
}

func (a *App) waitAndPrint(ctx context.Context, c *apiClient, id api.Uuid) error {
	job, err := a.waitJob(ctx, c, id, waitHooks{})
	if err != nil {
		if err == errInterrupted {
			return a.interruptedWait(id)
		}
		return err
	}
	body, err := c.jobResults(ctx, id, api.ListJobResultsParams{})
	if err != nil {
		if err == errInterrupted {
			return a.interruptedWait(id)
		}
		return err
	}
	if err := a.emit(body, resultView); err != nil {
		return err
	}
	return jobExit(job)
}
