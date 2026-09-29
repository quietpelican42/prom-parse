export class ParseError extends Error {
  readonly line: number;
  /** The message without the `line N` prefix. */
  readonly detail: string;

  constructor(detail: string, line: number) {
    super(`text format parsing error in line ${line}: ${detail}`);
    this.name = 'ParseError';
    this.line = line;
    this.detail = detail;
  }
}

export class SerializeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SerializeError';
  }
}
