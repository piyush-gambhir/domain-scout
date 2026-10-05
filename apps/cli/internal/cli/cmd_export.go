package cli

import (
	"context"
	"encoding/json"
	"net/http"
	"os"
	"path/filepath"

	"github.com/spf13/cobra"

	"github.com/piyush-gambhir/domain-scout/cli/internal/api"
)

// writeArtifact downloads to --out (atomically) or to stdout.
func (a *App) writeArtifact(ctx context.Context, c *apiClient, out string, fn callFn) error {
	if out == "" {
		return c.download(ctx, fn, a.Stdout)
	}
	dir := filepath.Dir(out)
	tmp, err := os.CreateTemp(dir, ".domain-scout-*.part")
	if err != nil {
		return failErr("cannot write to %s: %v", dir, err)
	}
	defer os.Remove(tmp.Name())
	if err := c.download(ctx, fn, tmp); err != nil {
		tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return failErr("cannot write %s: %v", out, err)
	}
	if err := os.Rename(tmp.Name(), out); err != nil {
		return failErr("cannot write %s: %v", out, err)
	}
	return nil
}

func (a *App) exportCmd() *cobra.Command {
	var (
		sf             scopeFlags
		format         string
		fields         []string
		includeNotes   bool
		candidatesOnly bool
		out            string
	)
	cmd := a.newCmd("export", "Create a TXT, CSV or JSON export with an explicit scope and download it", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			f := api.ExportCreateInputFormat(format)
			if !f.Valid() {
				return usageErr("--format must be txt, csv or json")
			}
			if candidatesOnly && f != api.ExportCreateInputFormatTxt {
				return usageErr("--candidates-only applies only to --format txt")
			}
			scope, err := sf.build(a)
			if err != nil {
				return err
			}
			body := api.ExportCreateInput{Format: f, Scope: scope, IncludeNotes: ptr(includeNotes), CandidatesOnly: ptr(candidatesOnly)}
			if len(fields) > 0 {
				fs := make([]api.ExportField, len(fields))
				for i, s := range fields {
					fs[i] = api.ExportField(s)
					if !fs[i].Valid() {
						return usageErr("unknown export field %q", s)
					}
				}
				body.Fields = &fs
			}
			c, err := a.api(ctx)
			if err != nil {
				return err
			}
			res, err := c.do(ctx, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateExport(ctx, body)
			})
			if err != nil {
				return err
			}
			var er api.ExportResponse
			if err := json.Unmarshal(res.body, &er); err != nil {
				return failErr("backend returned a malformed export: %v", err)
			}
			// Warnings carry uncertainty context (for example unresolved items
			// in a TXT candidate list); they belong on stderr, not in the file.
			for _, w := range er.Data.Warnings {
				a.progress("warning: %s", w)
			}
			a.progress("Export %s: %d item(s), %s.", er.Data.Id, er.Data.ItemCount, er.Data.FileName)
			id := er.Data.Id
			if err := a.writeArtifact(ctx, c, out, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.DownloadExport(ctx, id)
			}); err != nil {
				return err
			}
			if out == "" {
				return nil
			}
			return a.emit(res.body, exportView)
		})
	addScopeFlags(cmd, &sf)
	fl := cmd.Flags()
	fl.StringVar(&format, "format", "csv", "txt, csv or json")
	fl.StringSliceVar(&fields, "fields", nil, "export fields (default: the backend's standard set)")
	fl.BoolVar(&includeNotes, "include-notes", false, "include private notes")
	fl.BoolVar(&candidatesOnly, "candidates-only", false, "TXT only: names with no registry record or a positive provider confirmation")
	fl.StringVar(&out, "out", "", "write the file here and print the export envelope; default writes the file to stdout")

	var lp pageFlags
	list := a.newCmd("list", "Exports", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.list(ctx, lp, exportView, func(cursor *string, limit *int) callFn {
				p := api.ListExportsParams{Cursor: cursor, Limit: limit}
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.ListExports(ctx, &p) }
			})
		})
	addPageFlags(list, &lp)
	show := a.idCmd("show <export-id>", "Export metadata", "export id", exportView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.GetExport(ctx, id)
		})
	var dlOut string
	download := a.newCmd("download <export-id>", "Download an existing export", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id, err := parseID(args[0], "export id")
			if err != nil {
				return err
			}
			c, err := a.api(ctx)
			if err != nil {
				return err
			}
			return a.writeArtifact(ctx, c, dlOut, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.DownloadExport(ctx, id)
			})
		})
	download.Flags().StringVar(&dlOut, "out", "", "write the file here (default stdout)")
	del := a.idCmd("delete <export-id>", "Delete an export file", "export id", plainView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.DeleteExport(ctx, id)
		})
	cmd.AddCommand(list, show, download, del)
	return cmd
}

type snapshotFlags struct {
	sf             scopeFlags
	title          string
	includeNotes   bool
	noEvidence     bool
	noPrices       bool
	noRegistration bool
}

func addSnapshotFlags(cmd *cobra.Command, s *snapshotFlags) {
	addScopeFlags(cmd, &s.sf)
	fl := cmd.Flags()
	fl.StringVar(&s.title, "title", "", "snapshot title (required)")
	fl.BoolVar(&s.includeNotes, "include-notes", false, "include private notes (omitted by default)")
	fl.BoolVar(&s.noEvidence, "no-evidence", false, "omit evidence details")
	fl.BoolVar(&s.noPrices, "no-prices", false, "omit prices")
	fl.BoolVar(&s.noRegistration, "no-registration", false, "omit registration details")
}

func (s *snapshotFlags) body(a *App) (api.SnapshotCreateInput, error) {
	var body api.SnapshotCreateInput
	if s.title == "" {
		return body, usageErr("--title is required")
	}
	scope, err := s.sf.build(a)
	if err != nil {
		return body, err
	}
	body.Title = s.title
	body.Scope = scope
	body.Include = &struct {
		Evidence     *bool `json:"evidence,omitempty"`
		Notes        *bool `json:"notes,omitempty"`
		Prices       *bool `json:"prices,omitempty"`
		Registration *bool `json:"registration,omitempty"`
	}{Evidence: ptr(!s.noEvidence), Notes: ptr(s.includeNotes), Prices: ptr(!s.noPrices), Registration: ptr(!s.noRegistration)}
	return body, nil
}

func snapshotFormat(s string) (api.DownloadSnapshotParamsFormat, error) {
	f := api.DownloadSnapshotParamsFormat(s)
	if !f.Valid() {
		return f, usageErr("--format must be html or json")
	}
	return f, nil
}

func (a *App) snapshotCmd() *cobra.Command {
	var sn snapshotFlags
	var format, out string
	cmd := a.newCmd("snapshot", "Create a self-contained local share snapshot and download it", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			f, err := snapshotFormat(format)
			if err != nil {
				return err
			}
			body, err := sn.body(a)
			if err != nil {
				return err
			}
			c, err := a.api(ctx)
			if err != nil {
				return err
			}
			res, err := c.do(ctx, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.CreateSnapshot(ctx, body)
			})
			if err != nil {
				return err
			}
			var sr api.SnapshotResponse
			if err := json.Unmarshal(res.body, &sr); err != nil {
				return failErr("backend returned a malformed snapshot: %v", err)
			}
			a.progress("Snapshot %s: %d item(s).", sr.Data.Id, sr.Data.ItemCount)
			id := sr.Data.Id
			if err := a.writeArtifact(ctx, c, out, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.DownloadSnapshot(ctx, id, &api.DownloadSnapshotParams{Format: &f})
			}); err != nil {
				return err
			}
			if out == "" {
				return nil
			}
			return a.emit(res.body, snapshotView)
		})
	addSnapshotFlags(cmd, &sn)
	cmd.Flags().StringVar(&format, "format", "html", "download format: html or json")
	cmd.Flags().StringVar(&out, "out", "", "write the file here and print the snapshot envelope; default writes the file to stdout")

	var pv snapshotFlags
	preview := a.newCmd("preview", "Inspect what a snapshot would contain", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			body, err := pv.body(a)
			if err != nil {
				return err
			}
			return a.show(ctx, plainView, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.PreviewSnapshot(ctx, body)
			})
		})
	addSnapshotFlags(preview, &pv)

	var lp pageFlags
	list := a.newCmd("list", "Snapshots", cobra.NoArgs,
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			return a.list(ctx, lp, snapshotView, func(cursor *string, limit *int) callFn {
				p := api.ListSnapshotsParams{Cursor: cursor, Limit: limit}
				return func(ctx context.Context, g *api.Client) (*http.Response, error) { return g.ListSnapshots(ctx, &p) }
			})
		})
	addPageFlags(list, &lp)
	show := a.idCmd("show <snapshot-id>", "Snapshot metadata", "snapshot id", snapshotView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.GetSnapshot(ctx, id)
		})
	var dlFormat, dlOut string
	download := a.newCmd("download <snapshot-id>", "Download an existing snapshot", cobra.ExactArgs(1),
		func(ctx context.Context, cmd *cobra.Command, args []string) error {
			id, err := parseID(args[0], "snapshot id")
			if err != nil {
				return err
			}
			f, err := snapshotFormat(dlFormat)
			if err != nil {
				return err
			}
			c, err := a.api(ctx)
			if err != nil {
				return err
			}
			return a.writeArtifact(ctx, c, dlOut, func(ctx context.Context, g *api.Client) (*http.Response, error) {
				return g.DownloadSnapshot(ctx, id, &api.DownloadSnapshotParams{Format: &f})
			})
		})
	download.Flags().StringVar(&dlFormat, "format", "html", "html or json")
	download.Flags().StringVar(&dlOut, "out", "", "write the file here (default stdout)")
	del := a.idCmd("delete <snapshot-id>", "Delete a snapshot", "snapshot id", plainView,
		func(ctx context.Context, g *api.Client, id api.Uuid) (*http.Response, error) {
			return g.DeleteSnapshot(ctx, id)
		})
	cmd.AddCommand(preview, list, show, download, del)
	return cmd
}
