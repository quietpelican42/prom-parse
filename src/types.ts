export type MetricType =
  | 'counter'
  | 'gauge'
  | 'histogram'
  | 'gaugehistogram'
  | 'summary'
  | 'info'
  | 'stateset'
  | 'unknown';

export type Format = 'prometheus' | 'openmetrics';

export type Labels = Map<string, string>;

export interface Exemplar {
  labels: Labels;
  value: number;
  /** Milliseconds since the epoch. OpenMetrics writes seconds; they are converted. */
  timestamp?: number;
}

export interface Sample {
  /** The series name as written, including any `_bucket`, `_sum`, `_count`, `_total` or `_created` suffix. */
  name: string;
  labels: Labels;
  value: number;
  /** Milliseconds since the epoch. Prometheus text writes ms, OpenMetrics writes seconds; both are converted. */
  timestamp?: number;
  exemplar?: Exemplar;
}

export interface MetricFamily {
  /**
   * The family name. Counter families are named after their `_total` series
   * (`http_requests_total`), as in expfmt and prom-client, in both formats.
   */
  name: string;
  type: MetricType;
  help?: string;
  unit?: string;
  samples: Sample[];
}

export interface Bucket {
  upperBound: number;
  count: number;
  exemplar?: Exemplar;
}

export interface Quantile {
  quantile: number;
  value: number;
}

/**
 * One label set of a family, with its samples attached. Scalar types carry
 * `value`; histograms carry `buckets`, `sum`, `count`; summaries carry
 * `quantiles`, `sum`, `count`.
 */
export interface Metric {
  labels: Labels;
  timestamp?: number;
  value?: number;
  exemplar?: Exemplar;
  buckets?: Bucket[];
  quantiles?: Quantile[];
  sum?: number;
  count?: number;
  /** Value of the `_created` series in milliseconds since the epoch. */
  created?: number;
}

export interface ParseOptions {
  /** Default `'auto'`: OpenMetrics when a line equal to `# EOF` is present, Prometheus text otherwise. */
  format?: Format | 'auto';
  /**
   * Name validation, as expfmt's `model.ValidationScheme`. `'utf8'` (default)
   * accepts any valid UTF-8 name in quotes; `'legacy'` accepts only
   * `[a-zA-Z_:][a-zA-Z0-9_:]*` (Prometheus) or the same for metric names and
   * `[a-zA-Z_][a-zA-Z0-9_]*` for label names.
   */
  nameValidation?: 'utf8' | 'legacy';
}

export interface SerializeOptions {
  /** OpenMetrics only: write `_created` lines when a metric has `created`. Default false, as in expfmt. */
  createdLines?: boolean;
  /** OpenMetrics only: append `# EOF`. Default true. */
  eof?: boolean;
}
