// Split a .sql file into individual statements so each one can be sent to D1's
// HTTP query API and reported on separately.
//
// This is a deliberately small parser: it understands `--` line comments,
// single-quoted strings (with '' escapes), and `;` terminators. That covers
// db/schema.sql completely. It does NOT understand BEGIN…END blocks, so if a
// trigger or a multi-statement body is ever added to the schema, apply it with
// `wrangler d1 execute --file` instead and note it in docs/reference/database.md.

export function splitSqlStatements(sql) {
  const statements = [];
  let current = '';
  let inString = false;
  let inLineComment = false;

  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (ch === '\n') {
        inLineComment = false;
        current += ch;
      }
      continue;
    }

    if (inString) {
      current += ch;
      if (ch === "'") {
        if (next === "'") {
          current += next;
          i += 1;
        } else {
          inString = false;
        }
      }
      continue;
    }

    if (ch === '-' && next === '-') {
      inLineComment = true;
      i += 1;
      continue;
    }
    if (ch === "'") {
      inString = true;
      current += ch;
      continue;
    }
    if (ch === ';') {
      if (current.trim()) statements.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }

  if (current.trim()) statements.push(current.trim());
  return statements;
}

/** First line of a statement, shortened for progress output. */
export function describeStatement(sql) {
  const flat = sql.replace(/\s+/g, ' ').trim();
  return flat.length > 72 ? `${flat.slice(0, 69)}...` : flat;
}
