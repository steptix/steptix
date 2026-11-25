import fs from 'node:fs';
import zlib from 'node:zlib';
import { defineTool } from 'steptix/tools';

/**
 * Read the first worksheet of an Excel workbook (.xlsx) on the machine running
 * the SERVER, and capture its rows as text.
 *
 * Written for `[use agent]` tests (docs/specs/SPEC-use-agent.md) whose goal is
 * a file: the agent says it wrote a workbook, and a step after it needs to see
 * what is in it rather than take the agent's word. Nothing in the browser
 * vocabulary can open a file on disk, so this is a tool.
 *
 * No dependency on purpose. An .xlsx is a zip of XML parts; this reads the zip
 * directory, inflates the first `xl/worksheets/sheetN.xml` and
 * `xl/sharedStrings.xml`, and takes each cell's text: a shared string, an
 * inline string, or the value as written. Formulas give their cached value and
 * dates their serial number — enough to check what a test wrote, and not a
 * general reader.
 *
 * It fails through `step.expect` when the file is missing, is not a zip, has no
 * worksheet, or (with `header`) starts with a different first row.
 *
 * Usage:
 *
 *   4. [tool: read_xlsx path="{{orders_xlsx}}" header="Name,Total"]
 *   5. Verify that {{xlsx_row_count}} is 6
 *   6. Verify that {{xlsx_rows}} has a row for Ada with the total 12.50
 *
 * `xlsx_rows` is one line per row, its cells joined by " | ".
 */
export default defineTool({
  name: 'read_xlsx',
  description:
    'Read the first worksheet of an .xlsx workbook and capture its rows as text (one line per row, cells joined by " | ") and its row count. Fails when the file is not a readable workbook, or when header is given and the first row differs.',
  parameters: {
    path: {
      type: 'string',
      description: 'Absolute path to the .xlsx file.',
    },
    header: {
      type: 'string',
      default: '',
      description:
        'Optional. The first row\'s cells, comma-separated (e.g. "Name,Total"). When given, the step fails unless the first row is exactly these cells.',
    },
  },
  outputs: {
    xlsx_rows: { type: 'string', description: 'Every row of the first worksheet, one per line, cells joined by " | ".' },
    xlsx_row_count: { type: 'number', description: 'How many rows the first worksheet has, the header row included.' },
  },
  run({ path: filePath, header }, { step, log }) {
    let bytes: Buffer;
    try {
      bytes = fs.readFileSync(filePath);
    } catch (err) {
      step.expect(false, `read_xlsx: cannot read ${filePath} — ${(err as Error).message}`);
      return; // unreachable: step.expect threw.
    }

    let parts: Map<string, Buffer>;
    try {
      parts = unzip(bytes);
    } catch (err) {
      step.expect(false, `read_xlsx: ${filePath} is not a zip, so not an .xlsx workbook — ${(err as Error).message}`);
      return; // unreachable
    }

    const sheetName = [...parts.keys()]
      .filter((n) => /^xl\/worksheets\/sheet\d+\.xml$/.test(n))
      .sort((a, b) => Number(a.match(/\d+/)![0]) - Number(b.match(/\d+/)![0]))[0];
    if (sheetName === undefined) {
      step.expect(false, `read_xlsx: ${filePath} has no worksheet (no xl/worksheets/sheetN.xml)`);
      return; // unreachable
    }

    const shared = sharedStrings(parts.get('xl/sharedStrings.xml')?.toString('utf8') ?? '');
    const rows = sheetRows(parts.get(sheetName)!.toString('utf8'), shared);

    if (header.trim() !== '') {
      const want = header.split(',').map((c) => c.trim());
      const got = rows[0] ?? [];
      step.expect(
        want.length === got.length && want.every((c, i) => c === got[i]),
        `read_xlsx: the first row is "${got.join(', ')}", not "${want.join(', ')}"`,
      );
    }

    log.info(`read_xlsx: ${filePath} — ${sheetName}, ${rows.length} row(s)`);
    step.setVar('xlsx_rows', rows.map((r) => r.join(' | ')).join('\n'));
    step.setVar('xlsx_row_count', rows.length);
  },
});

/** Every entry of a zip, by name, inflated. Reads the central directory. */
function unzip(zip: Buffer): Map<string, Buffer> {
  // The end-of-central-directory record is the last 22 bytes, or further back
  // by the length of a trailing comment (at most 65,535 bytes).
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('no end-of-central-directory record');
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let n = 0; n < count; n++) {
    if (zip.readUInt32LE(at) !== 0x02014b50) throw new Error(`bad central directory entry ${n}`);
    const method = zip.readUInt16LE(at + 10);
    const compressedSize = zip.readUInt32LE(at + 20);
    const nameLength = zip.readUInt16LE(at + 28);
    const extraLength = zip.readUInt16LE(at + 30);
    const commentLength = zip.readUInt16LE(at + 32);
    const localAt = zip.readUInt32LE(at + 42);
    const name = zip.toString('utf8', at + 46, at + 46 + nameLength);
    at += 46 + nameLength + extraLength + commentLength;

    if (zip.readUInt32LE(localAt) !== 0x04034b50) throw new Error(`bad local header for ${name}`);
    const dataAt = localAt + 30 + zip.readUInt16LE(localAt + 26) + zip.readUInt16LE(localAt + 28);
    const data = zip.subarray(dataAt, dataAt + compressedSize);
    if (method === 0) out.set(name, Buffer.from(data));
    else if (method === 8) out.set(name, zlib.inflateRawSync(data));
    else throw new Error(`${name} uses compression method ${method}`);
  }
  return out;
}

function decodeXml(text: string): string {
  return text.replace(/&(lt|gt|amp|quot|apos|#\d+|#x[0-9a-fA-F]+);/g, (_, e: string) => {
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'amp') return '&';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    return String.fromCodePoint(e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
  });
}

/** The text of every `<t>` inside a fragment, joined: one string, rich text included. */
function textOf(fragment: string): string {
  let text = '';
  for (const m of fragment.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)) text += decodeXml(m[1]!);
  return text;
}

function sharedStrings(xml: string): string[] {
  return [...xml.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]!));
}

/** Column letters to a 0-based index: A → 0, Z → 25, AA → 26. */
function columnIndex(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? 'A';
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function sheetRows(xml: string, shared: string[]): string[][] {
  const rows: string[][] = [];
  for (const row of xml.matchAll(/<row\b[^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
    const cells: string[] = [];
    let next = 0;
    for (const c of (row[1] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = c[1]!;
      const body = c[2] ?? '';
      const ref = attrs.match(/\br="([A-Z]+\d+)"/)?.[1];
      const index = ref !== undefined ? columnIndex(ref) : next;
      const type = attrs.match(/\bt="(\w+)"/)?.[1];
      const v = body.match(/<v>([\s\S]*?)<\/v>/)?.[1];
      let text: string;
      if (type === 's') text = shared[Number(v)] ?? '';
      else if (type === 'inlineStr') text = textOf(body.match(/<is>([\s\S]*?)<\/is>/)?.[1] ?? '');
      else text = v !== undefined ? decodeXml(v) : '';
      while (cells.length < index) cells.push('');
      cells[index] = text;
      next = index + 1;
    }
    rows.push(cells);
  }
  return rows;
}
