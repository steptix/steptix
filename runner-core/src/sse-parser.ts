/**
 * Server-Sent Events frame parser.
 *
 * Implements just enough of the WHATWG event-source spec for what the
 * ai-ui-automation server emits: `event:` and `data:` fields, blank-line
 * frame terminator. Comments (lines starting with `:`) and unknown fields
 * are ignored.
 */

export interface SseFrame {
  /** Defaults to `"message"` per the spec when no `event:` field is present. */
  event: string;
  /** Concatenation of all `data:` lines, joined by '\n'. */
  data: string;
}

/**
 * Stateful parser. Feed chunks via `push(chunk)`; the returned array contains
 * any complete frames that became available.
 */
export class SseParser {
  private buffer = '';
  private currentEvent = '';
  private currentData: string[] = [];

  push(chunk: string): SseFrame[] {
    this.buffer += chunk;
    const out: SseFrame[] = [];

    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) >= 0) {
      // Strip trailing \r if present (handles \r\n line endings).
      const rawLine = this.buffer.slice(0, nl);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      this.buffer = this.buffer.slice(nl + 1);

      if (line === '') {
        // Frame terminator.
        if (this.currentData.length > 0 || this.currentEvent !== '') {
          out.push({
            event: this.currentEvent || 'message',
            data: this.currentData.join('\n'),
          });
        }
        this.currentEvent = '';
        this.currentData = [];
        continue;
      }

      if (line.startsWith(':')) continue; // comment

      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      // Per spec, a single space after the colon is stripped.
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'event') {
        this.currentEvent = value;
      } else if (field === 'data') {
        this.currentData.push(value);
      }
      // Other fields (id, retry) ignored.
    }

    return out;
  }

  /** Reset parser state, dropping any partial frame. */
  reset(): void {
    this.buffer = '';
    this.currentEvent = '';
    this.currentData = [];
  }
}
