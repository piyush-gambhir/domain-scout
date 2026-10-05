package cli

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"

	"github.com/spf13/cobra"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
	"github.com/piyush-gambhir/domain-scout/cli/internal/sse"
)

// inputFlags build an InputSource from --file/stdin, positional names, --tlds and --preset.
type inputFlags struct {
	file      string
	format    string
	csvColumn string
	tlds      []string
	preset    string
}

func addInputFlags(cmd *cobra.Command, f *inputFlags) {
	fl := cmd.Flags()
	fl.StringVarP(&f.file, "file", "f", "", "TXT or CSV input file; - reads stdin")
	fl.StringVar(&f.format, "format", "auto", "input format: auto, lines or csv")
	fl.StringVar(&f.csvColumn, "csv-column", "", "CSV header to read (default: first column)")
	fl.StringSliceVar(&f.tlds, "tlds", nil, "extensions to expand base names with, e.g. com,io,co.uk")
	fl.StringVar(&f.preset, "preset", "", "extension preset id whose suffixes are added")
}

func (a *App) inputSource(args []string, f *inputFlags) (api.InputSourceInput, error) {
	var src api.InputSourceInput
	format := api.InputSourceInputFormat(f.format)
	if !format.Valid() {
		return src, usageErr("--format must be auto, lines or csv")
	}
	// A "-" argument reads stdin, like --file -.
	var names []string
	for _, arg := range args {
		if arg == "-" {
			if f.file != "" && f.file != "-" {
				return src, usageErr("use either --file or - for stdin, not both")
			}
			f.file = "-"
			continue
		}
		names = append(names, arg)
	}
	if len(names) == 0 && f.file == "" {
		return src, usageErr("no input: pass names as arguments, --file FILE, or - to read stdin")
	}
	if f.file != "" {
		text, err := a.readSource(f.file)
		if err != nil {
			return src, err
		}
		src.Text = &text
	}
	if len(names) > 0 {
		src.Domains = ptr(append([]string{}, names...))
	}
	src.Format = &format
	src.CsvColumn = optStr(f.csvColumn)
	src.Extensions = optSlice(suffixes(f.tlds))
	src.PresetId = optStr(f.preset)
	return src, nil
}

func (a *App) inputCmd() *cobra.Command {
	var f inputFlags
	preview := a.newCmd("preview [names...|-]", "Parse, validate, expand and deduplicate input without external queries", cobra.ArbitraryArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			src, err := a.inputSource(args, &f)
			if err != nil {
				return err
			}
			return a.show(ctx, inputPreviewView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.PreviewInput(ctx, src)
			})
		})
	addInputFlags(preview, &f)
	return group("input", "Inspect input before scanning", preview)
}

func (a *App) scanCmd() *cobra.Command {
	var (
		f       inputFlags
		label   string
		recheck bool
		wait    bool
		key     string
	)
	cmd := a.newCmd("scan [names...|-]", "Submit a registry-only scan (never quotes or provider checks)", cobra.ArbitraryArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			src, err := a.inputSource(args, &f)
			if err != nil {
				return err
			}
			var body api.CreateJobRequestInput
			if err := body.FromScanJobRequestInput(api.ScanJobRequestInput{
				Type:    api.ScanJobRequestInputTypeRegistryScan,
				Label:   optStr(label),
				Input:   src,
				Recheck: ptr(recheck),
			}); err != nil {
				return failErr("cannot encode the scan: %v", err)
			}
			k := keyOrNew(key)
			return a.submit(ctx, wait, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateJob(ctx, &api.CreateJobParams{IdempotencyKey: &k}, body)
			})
		})
	addInputFlags(cmd, &f)
	cmd.Flags().StringVar(&label, "label", "", "job label")
	cmd.Flags().BoolVar(&recheck, "recheck", false, "ignore cached observations and query registries again")
	cmd.Flags().BoolVar(&wait, "wait", false, "wait for the job to finish, then print all results")
	idempotencyFlag(cmd, &key)
	return cmd
}

func (a *App) recheckCmd() *cobra.Command {
	var (
		file  string
		label string
		wait  bool
		key   string
	)
	cmd := a.newCmd("recheck [domains...]", "Fresh registry checks for selected domains (prior evidence is kept)", cobra.ArbitraryArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			ds, err := a.domains(args, file)
			if err != nil {
				return err
			}
			k := keyOrNew(key)
			body := api.RecheckRequest{Domains: ds, Label: optStr(label)}
			return a.submit(ctx, wait, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateRecheck(ctx, &api.CreateRecheckParams{IdempotencyKey: &k}, body)
			})
		})
	cmd.Flags().StringVarP(&file, "file", "f", "", "file with domains; - reads stdin")
	cmd.Flags().StringVar(&label, "label", "", "job label")
	cmd.Flags().BoolVar(&wait, "wait", false, "wait for the job to finish, then print all results")
	idempotencyFlag(cmd, &key)
	return cmd
}

func (a *App) jobsCmd() *cobra.Command {
	var lp pageFlags
	var jobType, jobState string
	list := a.newCmd("list", "List jobs", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			params := api.ListJobsParams{}
			if jobType != "" {
				if !api.JobType(jobType).Valid() {
					return usageErr("invalid --type %q", jobType)
				}
				params.Type = ptr(api.JobType(jobType))
			}
			if jobState != "" {
				if !api.JobState(jobState).Valid() {
					return usageErr("invalid --state %q", jobState)
				}
				params.State = ptr(api.JobState(jobState))
			}
			return a.list(ctx, lp, jobListView, func(cursor *string, limit *int) callFn {
				p := params
				p.Cursor, p.Limit = cursor, limit
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.ListJobs(ctx, &p) }
			})
		})
	addPageFlags(list, &lp)
	list.Flags().StringVar(&jobType, "type", "", "job type, e.g. registry_scan or quote")
	list.Flags().StringVar(&jobState, "state", "", "job state, e.g. running or completed_with_errors")

	show := a.idCmd("show <job-id>", "Job state and counters", "job id", jobView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.GetJob(ctx, id)
		})

	var rf filterFlags
	var rp pageFlags
	results := a.newCmd("results <job-id>", "Filtered, sorted, paginated job items", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id, err := parseID(args[0], "job id")
			if err != nil {
				return err
			}
			if err := rf.validate(); err != nil {
				return err
			}
			params := rf.params()
			return a.list(ctx, rp, resultView, func(cursor *string, limit *int) callFn {
				p := params
				p.Cursor, p.Limit = cursor, limit
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.ListJobResults(ctx, id, &p) }
			})
		})
	addFilterFlags(results, &rf)
	addPageFlags(results, &rp)

	watch := a.newCmd("watch <job-id>", "Stream job events until the job finishes", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id, err := parseID(args[0], "job id")
			if err != nil {
				return err
			}
			c, err := a.api(ctx)
			if err != nil {
				return err
			}
			printed := 0
			job, err := a.waitJob(ctx, c, id, waitHooks{
				onEvent: func(ev sse.Event) error { printed++; return a.emitEvent(ev) },
				onPoll:  func(raw []byte) error { printed++; return a.emit(raw, jobView) },
			})
			if err == errInterrupted {
				return a.interruptedWait(id)
			}
			if err != nil {
				return err
			}
			if printed == 0 {
				// The job was already finished: print its final state.
				_, raw, err := c.getJob(ctx, id)
				if err != nil {
					return err
				}
				if err := a.emit(raw, jobView); err != nil {
					return err
				}
			}
			return jobExit(job)
		})

	cancel := a.idCmd("cancel <job-id>", "Cancel a job, keeping completed evidence", "job id", jobView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.CancelJob(ctx, id)
		})

	var resumeWait bool
	resume := a.newCmd("resume <job-id>", "Resume unfinished items of an interrupted or cancelled job", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id, err := parseID(args[0], "job id")
			if err != nil {
				return err
			}
			return a.submitOnce(ctx, resumeWait, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.ResumeJob(ctx, id)
			})
		})
	resume.Flags().BoolVar(&resumeWait, "wait", false, "wait for the job to finish, then print all results")

	var (
		items          []string
		outcomes       []string
		unresolvedOnly bool
		retryWait      bool
		retryKey       string
	)
	retry := a.newCmd("retry <job-id>", "Retry selected or unresolved items as a new job", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id, err := parseID(args[0], "job id")
			if err != nil {
				return err
			}
			body := api.RetryRequestInput{Outcomes: optSlice(outcomes), UnresolvedOnly: ptr(unresolvedOnly)}
			if len(items) > 0 {
				ids, err := parseIDs(items, "--item")
				if err != nil {
					return err
				}
				body.ItemIds = &ids
			}
			k := keyOrNew(retryKey)
			return a.submit(ctx, retryWait, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.RetryJob(ctx, id, &api.RetryJobParams{IdempotencyKey: &k}, body)
			})
		})
	retry.Flags().StringSliceVar(&items, "item", nil, "item id to retry (repeatable)")
	retry.Flags().StringSliceVar(&outcomes, "outcome", nil, "retry finished items with this outcome (repeatable)")
	retry.Flags().BoolVar(&unresolvedOnly, "unresolved-only", true, "only retry unresolved items")
	retry.Flags().BoolVar(&retryWait, "wait", false, "wait for the new job to finish, then print all results")
	idempotencyFlag(retry, &retryKey)

	del := a.idCmd("delete <job-id>", "Delete a finished job (evidence used elsewhere is kept)", "job id", plainView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.DeleteJob(ctx, id)
		})

	return group("jobs", "Inspect and control durable jobs", list, show, results, watch, cancel, resume, retry, del)
}

// idCmd builds a command taking one UUID argument and printing one response.
func (a *App) idCmd(use, short, what string, v view, fn func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error)) *cobra.Command {
	return a.newCmd(use, short, cobra.ExactArgs(1), func(ctx context.Context, cmd *cobra.Command, args []string) error {
		id, err := parseID(args[0], what)
		if err != nil {
			return err
		}
		return a.show(ctx, v, func(ctx context.Context, g *api.Client) (*http.Response, error) { return fn(ctx, g, id) })
	})
}

// emitEvent prints one stream event: the DomainEvent JSON per line in json
// and ndjson modes, a short line in table mode.
func (a *App) emitEvent(ev sse.Event) error {
	if a.opts.output != outputTable {
		return writeCompact(a.Stdout, ev.Data)
	}
	var de domainEvent
	if err := json.Unmarshal(ev.Data, &de); err != nil {
		_, err := fmt.Fprintf(a.Stdout, "%s\t%s\n", ev.ID, strings.TrimSpace(string(ev.Data)))
		return err
	}
	job, watch := "-", "-"
	if de.JobID != nil {
		job = *de.JobID
	}
	if de.WatchID != nil {
		watch = *de.WatchID
	}
	_, err := fmt.Fprintf(a.Stdout, "%s  %s  %-16s job=%s watch=%s\n", de.EventID, de.OccurredAt, de.Type, job, watch)
	return err
}

func (a *App) eventsCmd() *cobra.Command {
	var jobID, watchID, after string
	var types []string
	cmd := a.newCmd("events", "Stream raw events (replays from --after); runs until interrupted", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			c, err := a.api(ctx)
			if err != nil {
				return err
			}
			params := api.StreamEventsParams{JobId: optStr(jobID), WatchId: optStr(watchID), Types: joinOpt(types)}
			stream := &sse.Stream{Open: c.openEvents(params), LastEventID: after, IdleTimeout: streamIdleTimeout}
			emitEv := func(ev sse.Event) (bool, error) { return false, a.emitEvent(ev) }
			err = stream.Run(ctx, sse.Handlers{OnEvent: emitEv, OnReset: emitEv})
			if ctx.Err() != nil {
				return &exitError{code: ExitInterrupted, note: true}
			}
			var e *exitError
			if errors.As(err, &e) {
				return e
			}
			if err != nil {
				return failErr("event stream ended: %v", err)
			}
			return nil
		})
	cmd.Flags().StringVar(&jobID, "job", "", "only events for this job id")
	cmd.Flags().StringVar(&watchID, "watch-id", "", "only events for this watch id")
	cmd.Flags().StringVar(&after, "after", "", "replay events after this event id")
	cmd.Flags().StringSliceVar(&types, "types", nil, "only these event types, e.g. job.updated,notice.created")
	return cmd
}
