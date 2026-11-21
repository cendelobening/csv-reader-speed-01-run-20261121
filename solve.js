// csv-reader-speed-01: a faster drop-in for csv-reader 1.0.0.
//
// Returns exactly csv-reader 1.0.0's answer {columns, rows, errors} for every
// input {text, header}, from one left-to-right pass. The semantics are the
// reference's own (BOM drop, LF/CRLF record ends, stray CR dropped with a
// stray_cr error, quoted fields with doubled quotes, quote_junk on trailing
// characters, unterminated quotes re-read as unquoted, short/long row
// padding/cutting, errors {code, line, row} in the order met).
//
// v2: indexOf fast paths on top of the v1 scanner. An unquoted field is cut
// to the next comma with one native indexOf and the short segment is checked
// for a line break or a stray CR (a stray CR is rare, so the check costs
// almost nothing); a quoted field's closing quote is found with one native
// indexOf and its content is taken as one slice when it holds no quote, CR
// or LF. Anything unusual (stray CR, doubled quote, CR/LF inside quotes,
// unterminated quote, junk after a closing quote) falls back to the plain
// single-pass scanner. Node stdlib only, no dependencies.
//
// v3: the quoted slow path also jumps with indexOf instead of scanning one
// character at a time, and converts CR/LF inside quotes only when the
// content actually holds one.

// How a field ended: at a comma (the record goes on), at a line break or at
// the end of the text (the record ends).
const COMMA = 0;
const BREAK = 1;
const END = 2;

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;

  const n = text.length;
  let pos = 0; // the next character to read
  let line = 1; // the line that character is on
  if (text.charCodeAt(0) === 0xfeff) pos = 1;

  // The record being read: the line it starts on and the index in rows it
  // takes (null: the header). Every error of the record carries these.
  let recordLine = 1;
  let recordRow = null;

  // Plain single-pass scan of an unquoted field (the slow path: a stray CR
  // hides in it). `added` counts the characters kept here.
  function readUnquotedSlow(value, added) {
    let start = pos;
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 44) {
        // ','
        value += text.slice(start, pos);
        added += pos - start;
        pos += 1;
        return { value, ended: COMMA, added };
      }
      if (c === 10) {
        // '\n'
        value += text.slice(start, pos);
        added += pos - start;
        pos += 1;
        line += 1;
        return { value, ended: BREAK, added };
      }
      if (c === 13) {
        // '\r'
        if (text.charCodeAt(pos + 1) === 10) {
          value += text.slice(start, pos);
          added += pos - start;
          pos += 2;
          line += 1;
          return { value, ended: BREAK, added };
        }
        errors.push({ code: 'stray_cr', line: recordLine, row: recordRow });
        value += text.slice(start, pos);
        added += pos - start;
        pos += 1;
        start = pos;
        continue;
      }
      pos += 1;
    }
    value += text.slice(start, pos);
    added += pos - start;
    return { value, ended: END, added };
  }

  // Reads unquoted characters onto `value` up to the next comma or line
  // break: a CR not followed by LF is dropped (stray_cr). Returns the field
  // and how it ended; `added` counts the characters kept here (a quoted
  // field's trailing junk is an error only when it adds characters).
  function readUnquoted(value) {
    let added = 0;
    let iC = text.indexOf(',', pos);
    if (iC < 0) iC = n;
    const seg = text.slice(pos, iC);
    const nl = seg.indexOf('\n');
    if (nl >= 0) {
      // The field ends at the LF inside the segment (a CR just before it
      // makes it a CRLF end).
      let end = nl;
      if (nl > 0 && seg.charCodeAt(nl - 1) === 13) end = nl - 1;
      const head = seg.slice(0, end);
      if (head.indexOf('\r') >= 0) return readUnquotedSlow(value, added);
      value += head;
      added += head.length;
      pos += nl + 1;
      line += 1;
      return { value, ended: BREAK, added };
    }
    if (seg.indexOf('\r') >= 0) return readUnquotedSlow(value, added);
    value += seg;
    added += seg.length;
    if (iC >= n) {
      pos = n;
      return { value, ended: END, added };
    }
    pos = iC + 1;
    return { value, ended: COMMA, added };
  }

  // What follows a quoted field's closing quote: a comma, a line break, the
  // end of the text, or trailing junk appended as it stands.
  function afterClose(value) {
    if (pos >= n) return { value, ended: END, added: 0 };
    const c = text.charCodeAt(pos);
    if (c === 44) {
      pos += 1;
      return { value, ended: COMMA, added: 0 };
    }
    if (c === 10) {
      pos += 1;
      line += 1;
      return { value, ended: BREAK, added: 0 };
    }
    if (c === 13 && text.charCodeAt(pos + 1) === 10) {
      pos += 2;
      line += 1;
      return { value, ended: BREAK, added: 0 };
    }
    const junk = readUnquoted(value);
    if (junk.added > 0) errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
    return junk;
  }

  // Plain scan of a quoted field (the slow path: a doubled quote or a CR/LF
  // hides inside it). The closing quote is found by jumping from quote to
  // quote with indexOf; the content's CR/LF are converted to LF, and the
  // lines they span counted, only when the content actually holds one.
  function readQuotedSlow(open, openLine) {
    let i = open + 1;
    let segs = null; // segments split at doubled quotes (null: none seen)
    let close = -1;
    while (true) {
      const j = text.indexOf('"', i);
      if (j < 0) {
        // The quote never closes: it is a literal character, and the text
        // after it is read again as unquoted.
        pos = open + 1;
        line = openLine;
        errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
        return readUnquoted('"');
      }
      if (text.charCodeAt(j + 1) === 34) {
        if (segs === null) segs = [];
        segs.push(text.slice(i, j));
        i = j + 2;
        continue;
      }
      close = j;
      break;
    }
    let value;
    if (segs === null) {
      value = text.slice(open + 1, close);
    } else {
      segs.push(text.slice(i, close));
      value = segs.join('"');
    }
    if (value.indexOf('\n') >= 0 || value.indexOf('\r') >= 0) {
      // CRLF and a lone CR inside quotes are each one LF.
      let out = '';
      let start = 0;
      let breaks = 0;
      for (let k = 0; k < value.length; k++) {
        const c = value.charCodeAt(k);
        if (c === 13) {
          out += value.slice(start, k);
          out += '\n';
          breaks += 1;
          if (value.charCodeAt(k + 1) === 10) k += 1;
          start = k + 1;
        } else if (c === 10) {
          out += value.slice(start, k);
          out += '\n';
          breaks += 1;
          start = k + 1;
        }
      }
      out += value.slice(start);
      value = out;
      line += breaks;
    }
    pos = close + 1;
    return afterClose(value);
  }

  // Reads a quoted field whose opening quote is at pos.
  function readQuoted() {
    const open = pos;
    const openLine = line;
    const j = text.indexOf('"', pos + 1);
    if (j < 0) {
      // No closing quote anywhere: the quote is a literal character, and
      // the text after it is read again as unquoted.
      pos = open + 1;
      line = openLine;
      errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
      return readUnquoted('"');
    }
    if (text.charCodeAt(j + 1) === 34) return readQuotedSlow(open, openLine);
    // The quote at j closes the field and the content holds no quote.
    const content = text.slice(pos + 1, j);
    if (content.indexOf('\n') >= 0 || content.indexOf('\r') >= 0) return readQuotedSlow(open, openLine);
    pos = j + 1;
    return afterClose(content);
  }

  while (true) {
    // Lines with no characters are no records.
    while (pos < n) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= n) break;

    recordLine = line;
    recordRow = header && columns === null ? null : rows.length;
    const fields = [];
    let field;
    let quoted;
    do {
      quoted = text.charCodeAt(pos) === 34;
      field = quoted ? readQuoted() : readUnquoted('');
      fields.push(field.value);
    } while (field.ended === COMMA);

    // A line that held only stray CRs is left with no characters: no record
    // (its stray_cr errors stay).
    if (fields.length === 1 && fields[0] === '' && !quoted) continue;

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
