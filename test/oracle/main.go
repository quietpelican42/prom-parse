// Oracle helper: runs prometheus/common expfmt over cases read from a JSON file and prints results as JSON.
package main

import (
	"bytes"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"os"
	"strconv"
	"strings"
	"time"

	dto "github.com/prometheus/client_model/go"
	"github.com/prometheus/common/expfmt"
	"github.com/prometheus/common/model"
	"google.golang.org/protobuf/proto"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func f64(v float64) string {
	if math.IsNaN(v) {
		return "NaN"
	}
	return strconv.FormatUint(math.Float64bits(v), 16)
}

func parseF(s string) float64 {
	v, err := strconv.ParseFloat(s, 64)
	if err != nil {
		panic(err)
	}
	return v
}

type Metric struct {
	Labels    [][2]string `json:"labels"`
	Ts        *int64      `json:"ts"`
	Value     *string     `json:"value,omitempty"`
	Sum       *string     `json:"sum,omitempty"`
	Count     *string     `json:"count,omitempty"`
	Buckets   [][2]string `json:"buckets,omitempty"`
	Quantiles [][2]string `json:"quantiles,omitempty"`
}

type Family struct {
	Name    string   `json:"name"`
	Type    string   `json:"type"`
	Help    *string  `json:"help"`
	Metrics []Metric `json:"metrics"`
}

func sp(v float64) *string { s := f64(v); return &s }

func canon(mf *dto.MetricFamily) Family {
	f := Family{Name: mf.GetName(), Type: strings.ToLower(mf.GetType().String()), Help: mf.Help, Metrics: []Metric{}}
	for _, m := range mf.Metric {
		cm := Metric{Labels: [][2]string{}, Ts: m.TimestampMs}
		for _, l := range m.Label {
			cm.Labels = append(cm.Labels, [2]string{l.GetName(), l.GetValue()})
		}
		switch {
		case m.Counter != nil:
			cm.Value = sp(m.Counter.GetValue())
		case m.Gauge != nil:
			cm.Value = sp(m.Gauge.GetValue())
		case m.Untyped != nil:
			cm.Value = sp(m.Untyped.GetValue())
		case m.Summary != nil:
			s := m.Summary
			if s.SampleSum != nil {
				cm.Sum = sp(s.GetSampleSum())
			}
			if s.SampleCount != nil {
				cm.Count = sp(float64(s.GetSampleCount()))
			}
			for _, q := range s.Quantile {
				cm.Quantiles = append(cm.Quantiles, [2]string{f64(q.GetQuantile()), f64(q.GetValue())})
			}
		case m.Histogram != nil:
			h := m.Histogram
			if h.SampleSum != nil {
				cm.Sum = sp(h.GetSampleSum())
			}
			if h.SampleCountFloat != nil {
				cm.Count = sp(h.GetSampleCountFloat())
			} else if h.SampleCount != nil {
				cm.Count = sp(float64(h.GetSampleCount()))
			}
			for _, b := range h.Bucket {
				c := float64(b.GetCumulativeCount())
				if b.CumulativeCountFloat != nil {
					c = b.GetCumulativeCountFloat()
				}
				cm.Buckets = append(cm.Buckets, [2]string{f64(b.GetUpperBound()), f64(c)})
			}
		}
		f.Metrics = append(f.Metrics, cm)
	}
	return f
}

type Result struct {
	Ok    []Family `json:"ok,omitempty"`
	Err   *ErrInfo `json:"err,omitempty"`
	Panic string   `json:"panic,omitempty"`
}
type ErrInfo struct {
	Line int    `json:"line"`
	Msg  string `json:"msg"`
}

func runText(data []byte, scheme model.ValidationScheme) (res Result) {
	defer func() {
		if r := recover(); r != nil {
			res = Result{Panic: fmt.Sprint(r)}
		}
	}()
	p := expfmt.NewTextParser(scheme)
	out, err := p.TextToMetricFamilies(bytes.NewReader(data))
	if err != nil {
		if pe, ok := err.(expfmt.ParseError); ok {
			return Result{Err: &ErrInfo{pe.Line, pe.Msg}}
		}
		return Result{Err: &ErrInfo{-1, err.Error()}}
	}
	fams := []Family{}
	for _, mf := range out {
		fams = append(fams, canon(mf))
	}
	return Result{Ok: fams}
}

// ---- encode ----

type EIn struct {
	Fam     EFam   `json:"fam"`
	Format  string `json:"format"`
	Created bool   `json:"created"`
}
type EFam struct {
	Name    string    `json:"name"`
	Type    string    `json:"type"`
	Help    *string   `json:"help"`
	Unit    *string   `json:"unit"`
	Metrics []EMetric `json:"metrics"`
}
type EEx struct {
	Labels [][2]string `json:"labels"`
	Value  string      `json:"value"`
	Ts     *int64      `json:"ts"`
}
type EBucket struct {
	Ub       string `json:"ub"`
	Count    string `json:"count"`
	Float    bool   `json:"float"`
	Exemplar *EEx   `json:"exemplar"`
}
type EMetric struct {
	Labels     [][2]string `json:"labels"`
	Ts         *int64      `json:"ts"`
	Value      *string     `json:"value"`
	Exemplar   *EEx        `json:"exemplar"`
	Created    *int64      `json:"created"`
	Sum        *string     `json:"sum"`
	Count      *string     `json:"count"`
	CountFloat bool        `json:"countFloat"`
	Buckets    []EBucket   `json:"buckets"`
	Quantiles  [][2]string `json:"quantiles"`
}

func exemplar(e *EEx) *dto.Exemplar {
	if e == nil {
		return nil
	}
	x := &dto.Exemplar{Value: proto.Float64(parseF(e.Value))}
	for _, l := range e.Labels {
		x.Label = append(x.Label, &dto.LabelPair{Name: proto.String(l[0]), Value: proto.String(l[1])})
	}
	if e.Ts != nil {
		x.Timestamp = timestamppb.New(time.UnixMilli(*e.Ts))
	}
	return x
}

func buildFam(in EFam) *dto.MetricFamily {
	mf := &dto.MetricFamily{Name: proto.String(in.Name), Help: in.Help, Unit: in.Unit}
	types := map[string]dto.MetricType{"counter": dto.MetricType_COUNTER, "gauge": dto.MetricType_GAUGE, "summary": dto.MetricType_SUMMARY, "untyped": dto.MetricType_UNTYPED, "histogram": dto.MetricType_HISTOGRAM, "gaugehistogram": dto.MetricType_GAUGE_HISTOGRAM}
	t := types[in.Type]
	mf.Type = t.Enum()
	for _, m := range in.Metrics {
		dm := &dto.Metric{TimestampMs: m.Ts}
		for _, l := range m.Labels {
			dm.Label = append(dm.Label, &dto.LabelPair{Name: proto.String(l[0]), Value: proto.String(l[1])})
		}
		var created *timestamppb.Timestamp
		if m.Created != nil {
			created = timestamppb.New(time.UnixMilli(*m.Created))
		}
		switch t {
		case dto.MetricType_COUNTER:
			dm.Counter = &dto.Counter{Value: proto.Float64(parseF(*m.Value)), Exemplar: exemplar(m.Exemplar), CreatedTimestamp: created}
		case dto.MetricType_GAUGE:
			dm.Gauge = &dto.Gauge{Value: proto.Float64(parseF(*m.Value))}
		case dto.MetricType_UNTYPED:
			dm.Untyped = &dto.Untyped{Value: proto.Float64(parseF(*m.Value))}
		case dto.MetricType_SUMMARY:
			s := &dto.Summary{CreatedTimestamp: created}
			if m.Sum != nil {
				s.SampleSum = proto.Float64(parseF(*m.Sum))
			}
			if m.Count != nil {
				s.SampleCount = proto.Uint64(uint64(parseF(*m.Count)))
			}
			for _, q := range m.Quantiles {
				s.Quantile = append(s.Quantile, &dto.Quantile{Quantile: proto.Float64(parseF(q[0])), Value: proto.Float64(parseF(q[1]))})
			}
			dm.Summary = s
		default:
			h := &dto.Histogram{CreatedTimestamp: created}
			if m.Sum != nil {
				h.SampleSum = proto.Float64(parseF(*m.Sum))
			}
			if m.Count != nil {
				if m.CountFloat {
					h.SampleCountFloat = proto.Float64(parseF(*m.Count))
				} else {
					h.SampleCount = proto.Uint64(uint64(parseF(*m.Count)))
				}
			}
			for _, b := range m.Buckets {
				db := &dto.Bucket{UpperBound: proto.Float64(parseF(b.Ub)), Exemplar: exemplar(b.Exemplar)}
				if b.Float {
					db.CumulativeCountFloat = proto.Float64(parseF(b.Count))
				} else {
					db.CumulativeCount = proto.Uint64(uint64(parseF(b.Count)))
				}
				h.Bucket = append(h.Bucket, db)
			}
			dm.Histogram = h
		}
		mf.Metric = append(mf.Metric, dm)
	}
	return mf
}

type EOut struct {
	Out string `json:"out"`
	Err string `json:"err,omitempty"`
}

func encode(in EIn) (o EOut) {
	defer func() {
		if r := recover(); r != nil {
			o = EOut{Err: "panic: " + fmt.Sprint(r)}
		}
	}()
	mf := buildFam(in.Fam)
	var buf bytes.Buffer
	var err error
	if in.Format == "text" {
		_, err = expfmt.MetricFamilyToText(&buf, mf)
	} else {
		var opts []expfmt.EncoderOption
		if in.Created {
			opts = append(opts, expfmt.WithCreatedLines())
		}
		_, err = expfmt.MetricFamilyToOpenMetrics(&buf, mf, opts...)
	}
	if err != nil {
		return EOut{Out: buf.String(), Err: err.Error()}
	}
	return EOut{Out: buf.String()}
}

func main() {
	mode := os.Args[1]
	raw, err := os.ReadFile(os.Args[2])
	if err != nil {
		panic(err)
	}
	switch mode {
	case "parse":
		var cases []string
		json.Unmarshal(raw, &cases)
		type R struct {
			Utf8   Result `json:"utf8"`
			Legacy Result `json:"legacy"`
		}
		out := make([]R, len(cases))
		for i, h := range cases {
			b, _ := hex.DecodeString(h)
			out[i] = R{runText(b, model.UTF8Validation), runText(b, model.LegacyValidation)}
		}
		json.NewEncoder(os.Stdout).Encode(out)
	case "encode":
		var cases []EIn
		json.Unmarshal(raw, &cases)
		out := make([]EOut, len(cases))
		for i, c := range cases {
			out[i] = encode(c)
		}
		json.NewEncoder(os.Stdout).Encode(out)
	}
}
