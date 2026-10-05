package cli

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strconv"
	"strings"
	"text/tabwriter"
)

// Output modes.
const (
	outputJSON   = "json"
	outputTable  = "table"
	outputNDJSON = "ndjson"
)

// col is one table column: a dotted JSON path or a computed value.
type col struct {
	header string
	path   string
	fn     func(row map[string]any) string
}

// view describes how table and ndjson modes render a response. JSON mode
// always prints the API envelope verbatim and ignores the view.
type view struct {
	// list names a key inside data whose array is rendered as rows; empty
	// renders data itself (an array for pages, an object otherwise).
	list string
	cols []col
	// summary columns are printed as key/value lines above the rows (table mode).
	summary []col
}

// emit prints an API envelope to stdout in the selected output mode.
func (a *App) emit(body []byte, v view) error {
	switch a.opts.output {
	case outputJSON:
		return writeLine(a.Stdout, body)
	case outputNDJSON:
		items, single, err := extract(body, v.list)
		if err != nil {
			return err
		}
		if single != nil {
			items = []json.RawMessage{single}
		}
		for _, it := range items {
			if err := writeCompact(a.Stdout, it); err != nil {
				return err
			}
		}
		return nil
	default:
		return a.emitTable(body, v)
	}
}

func writeLine(w io.Writer, b []byte) error {
	if _, err := w.Write(b); err != nil {
		return err
	}
	if len(b) == 0 || b[len(b)-1] != '\n' {
		_, err := io.WriteString(w, "\n")
		return err
	}
	return nil
}

func writeCompact(w io.Writer, raw json.RawMessage) error {
	var buf bytes.Buffer
	if err := json.Compact(&buf, raw); err != nil {
		return failErr("backend returned malformed JSON: %v", err)
	}
	buf.WriteByte('\n')
	_, err := w.Write(buf.Bytes())
	return err
}

// extract returns the rows of an envelope: an array (items) or one object (single).
func extract(body []byte, list string) (items []json.RawMessage, single json.RawMessage, err error) {
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return nil, nil, failErr("backend returned malformed JSON: %v", err)
	}
	data := env.Data
	if list != "" {
		var obj map[string]json.RawMessage
		if err := json.Unmarshal(data, &obj); err == nil {
			if inner, ok := obj[list]; ok {
				data = inner
			}
		}
	}
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) > 0 && trimmed[0] == '[' {
		if err := json.Unmarshal(trimmed, &items); err != nil {
			return nil, nil, failErr("backend returned malformed JSON: %v", err)
		}
		return items, nil, nil
	}
	return nil, trimmed, nil
}

func decodeObject(raw []byte) map[string]any {
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.UseNumber()
	var m map[string]any
	_ = dec.Decode(&m)
	return m
}

func (a *App) emitTable(body []byte, v view) error {
	var env struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &env); err != nil {
		return failErr("backend returned malformed JSON: %v", err)
	}
	tw := tabwriter.NewWriter(a.Stdout, 0, 0, 2, ' ', 0)
	if len(v.summary) > 0 {
		obj := decodeObject(env.Data)
		for _, c := range v.summary {
			fmt.Fprintf(tw, "%s\t%s\n", c.header, c.value(obj))
		}
		fmt.Fprintln(tw)
	}
	items, single, err := extract(body, v.list)
	if err != nil {
		return err
	}
	if single != nil {
		writeKeyValues(tw, single)
		return tw.Flush()
	}
	cols := v.cols
	if len(cols) == 0 && len(items) > 0 {
		cols = inferColumns(items[0])
	}
	if len(items) == 0 {
		tw.Flush()
		fmt.Fprintln(a.Stdout, "(no results)")
		return nil
	}
	headers := make([]string, len(cols))
	for i, c := range cols {
		headers[i] = c.header
	}
	fmt.Fprintln(tw, strings.Join(headers, "\t"))
	for _, it := range items {
		row := decodeObject(it)
		cells := make([]string, len(cols))
		for i, c := range cols {
			cells[i] = c.value(row)
		}
		fmt.Fprintln(tw, strings.Join(cells, "\t"))
	}
	return tw.Flush()
}

func (c col) value(row map[string]any) string {
	if c.fn != nil {
		return c.fn(row)
	}
	return cell(lookup(row, c.path))
}

func writeKeyValues(w io.Writer, raw json.RawMessage) {
	obj := decodeObject(raw)
	for _, k := range orderedKeys(raw) {
		fmt.Fprintf(w, "%s\t%s\n", k, cell(obj[k]))
	}
}

// inferColumns uses the scalar top-level fields of the first row, in order.
func inferColumns(raw json.RawMessage) []col {
	obj := decodeObject(raw)
	var cols []col
	for _, k := range orderedKeys(raw) {
		switch obj[k].(type) {
		case map[string]any, []any:
			continue
		}
		cols = append(cols, col{header: strings.ToUpper(k), path: k})
	}
	return cols
}

// orderedKeys lists an object's keys in document order.
func orderedKeys(raw json.RawMessage) []string {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil
	}
	var keys []string
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			break
		}
		k, _ := tok.(string)
		keys = append(keys, k)
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			break
		}
	}
	return keys
}

func lookup(row map[string]any, path string) any {
	var cur any = row
	for _, part := range strings.Split(path, ".") {
		m, ok := cur.(map[string]any)
		if !ok {
			return nil
		}
		cur = m[part]
	}
	return cur
}

const maxCell = 72

// cell renders one JSON value for a human table.
func cell(v any) string {
	switch x := v.(type) {
	case nil:
		return "-"
	case string:
		return clip(strings.Join(strings.Fields(x), " "))
	case json.Number:
		return x.String()
	case bool:
		return strconv.FormatBool(x)
	case []any:
		if len(x) == 0 {
			return "-"
		}
		parts := make([]string, 0, len(x))
		for _, e := range x {
			switch e.(type) {
			case map[string]any, []any:
				b, _ := json.Marshal(x)
				return clip(string(b))
			}
			parts = append(parts, cell(e))
		}
		return clip(strings.Join(parts, ","))
	case map[string]any:
		b, _ := json.Marshal(x) // map keys are sorted by encoding/json
		return clip(string(b))
	default:
		return fmt.Sprint(x)
	}
}

func clip(s string) string {
	if len(s) <= maxCell {
		return s
	}
	return s[:maxCell-3] + "..."
}

// Column helpers.

func c(header, path string) col { return col{header: header, path: path} }

func money(amountPath, currencyPath string) func(map[string]any) string {
	return func(row map[string]any) string {
		amt := lookup(row, amountPath)
		if amt == nil {
			return "-"
		}
		cur := lookup(row, currencyPath)
		if cur == nil {
			return cell(amt)
		}
		return cell(amt) + " " + cell(cur)
	}
}

func count(path string) func(map[string]any) string {
	return func(row map[string]any) string {
		if arr, ok := lookup(row, path).([]any); ok {
			return strconv.Itoa(len(arr))
		}
		return "-"
	}
}

func pluck(path, field string) func(map[string]any) string {
	return func(row map[string]any) string {
		arr, ok := lookup(row, path).([]any)
		if !ok || len(arr) == 0 {
			return "-"
		}
		var out []string
		for _, e := range arr {
			if m, ok := e.(map[string]any); ok {
				out = append(out, cell(m[field]))
			}
		}
		return clip(strings.Join(out, ","))
	}
}

func ratio(num, den string) func(map[string]any) string {
	return func(row map[string]any) string {
		return cell(lookup(row, num)) + "/" + cell(lookup(row, den))
	}
}

// keys returns sorted map keys (used for stable human summaries).
func keys(m map[string]int) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}
