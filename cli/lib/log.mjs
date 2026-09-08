// Terminal output. This is the ONE place the CLI's visual vocabulary is defined,
// so every command aligns and reads the same way.
//
// The vocabulary, in full. If you need a shape that is not here, add it here
// rather than hand-rolling spacing in a command:
//
//   heading(t)        a top-level banner between phases
//   step(t)           a numbered phase:  [3/10] Storage
//   section(t)        an unnumbered sub-heading inside a phase
//   ok(m)             ✓  something was created or changed
//   skip(m)           ·  already in the desired state (dimmed: it is not news)
//   warn(m)           !  worth reading, not a failure
//   fail(m)           ✗  this step did not work
//   detail(m)         indented continuation under the line above
//   hint(m)           indented, dimmed: what to do about it
//   kv(k, v)          an aligned label/value row
//   table(rows)       aligned columns, computed from the widest cell
//   summary(parts)    the counts line that closes a command
//
// Indentation is fixed at two spaces for status lines and six for their
// continuations, so a wall of output still has one left edge to scan.
//
// No color when stdout is not a TTY, or when NO_COLOR is set, so piped output
// and CI logs stay readable.

const useColor = process.stdout.isTTY && !process.env.NO_COLOR;
const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : String(s));

export const color = {
  bold: wrap('1'),
  dim: wrap('2'),
  red: wrap('31'),
  green: wrap('32'),
  yellow: wrap('33'),
  blue: wrap('34'),
  cyan: wrap('36'),
};

// One symbol per outcome, defined once. Commands must not invent their own.
export const sym = {
  ok: color.green('✓'),
  skip: color.dim('·'),
  warn: color.yellow('!'),
  fail: color.red('✗'),
  arrow: color.dim('→'),
};

// ── verbosity ───────────────────────────────────────────────────────────────
//
// Default output is a summary: what changed, what did not, what needs a human.
// `--verbose` adds the things that are usually noise, such as the wrangler
// command line, its full output and every skipped sub-check, for when a step is
// misbehaving and you need to see the actual calls.

let verbose = false;
export function setVerbose(value) {
  verbose = Boolean(value);
}
export function isVerbose() {
  return verbose;
}

/** Printed only under --verbose. Use for command lines and raw tool output. */
export function trace(msg) {
  if (verbose) console.log(`      ${color.dim(msg)}`);
}

// ── structure ───────────────────────────────────────────────────────────────

let stepNumber = 0;
let stepTotal = 0;

/**
 * Declare how many numbered steps are coming, so each one can show `[3/10]`.
 * A reader can then tell "two steps left" from "ten steps left", which a bare
 * `[3]` never conveys. Optional: with no total, steps print as `[3]`.
 */
export function setStepTotal(total) {
  stepTotal = Number(total) || 0;
}

/** A numbered top-level step. Resets with resetSteps(). */
export function step(title) {
  stepNumber += 1;
  const counter = stepTotal ? `${stepNumber}/${stepTotal}` : String(stepNumber);
  process.stdout.write(`\n${color.bold(`[${counter}] ${title}`)}\n`);
}

export function resetSteps() {
  stepNumber = 0;
  stepTotal = 0;
}

/** An unnumbered sub-heading inside a step or a report. */
export function section(title) {
  console.log(`\n${color.bold(title)}`);
}

export function heading(msg) {
  console.log(`\n${color.bold(msg)}`);
}

// ── status lines ────────────────────────────────────────────────────────────

/** Something was created or changed. */
export const ok = (msg) => console.log(`  ${sym.ok} ${msg}`);

/** Already in the desired state. Dimmed, because "nothing happened" is not news. */
export const skip = (msg) => console.log(`  ${sym.skip} ${color.dim(msg)}`);

/** Worth reading, but not a failure. */
export const warn = (msg) => console.log(`  ${sym.warn} ${msg}`);

/** A step failed; the run continues but a manual follow-up is needed. */
export const fail = (msg) => console.log(`  ${sym.fail} ${msg}`);

export const info = (msg) => console.log(`  ${msg}`);
export const plain = (msg = '') => console.log(msg);

/** Continuation of the line above, indented under its symbol. */
export function detail(msg) {
  for (const line of String(msg).split('\n')) console.log(`      ${line}`);
}

/** What to do about the line above. Dimmed, because it is guidance, not state. */
export function hint(msg) {
  for (const line of String(msg).split('\n')) console.log(`      ${color.dim(line)}`);
}

// ── aligned data ────────────────────────────────────────────────────────────

const KV_WIDTH = 14;

/** An aligned `label   value` row. Shared width so separate blocks line up. */
export function kv(label, value) {
  console.log(`  ${color.dim(String(label).padEnd(KV_WIDTH))} ${value}`);
}

/**
 * Aligned columns, sized from the widest cell in each column rather than a
 * hardcoded pad, so a long hostname widens the table instead of wrapping into
 * the next column.
 *
 * `rows` is an array of arrays of strings. Padding is measured on the visible
 * text, so a cell that is already colored keeps its escape codes out of the
 * width calculation.
 */
export function table(rows, { indent = '  ', gap = 2 } = {}) {
  if (!rows.length) return;
  const visible = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');
  const widths = [];
  for (const row of rows) {
    row.forEach((cell, i) => {
      widths[i] = Math.max(widths[i] || 0, visible(cell).length);
    });
  }
  const pad = ' '.repeat(gap);
  for (const row of rows) {
    const line = row
      .map((cell, i) => {
        // The last column never needs trailing padding.
        if (i === row.length - 1) return String(cell);
        return String(cell) + ' '.repeat(widths[i] - visible(cell).length);
      })
      .join(pad);
    console.log(indent + line.trimEnd());
  }
}

/**
 * The counts line that closes a command: `12 ok · 2 warnings · 1 problem`.
 * Zero-valued parts are dropped, so a clean run reads simply `14 ok`.
 */
export function summary(parts) {
  const shown = parts.filter((p) => p && p.count > 0);
  if (!shown.length) return;
  const painted = shown.map((p) => {
    const label = p.count === 1 ? p.one : p.many;
    const text = `${p.count} ${label}`;
    return p.color ? color[p.color](text) : text;
  });
  heading(painted.join(color.dim(' · ')));
}

/** Fatal: print and exit non-zero. Used for unrecoverable input errors. */
export function die(msg) {
  console.error(`\n${color.red('error')} ${msg}\n`);
  process.exit(1);
}
