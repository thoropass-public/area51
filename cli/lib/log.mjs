// Terminal output helpers. No dependencies, and no color when the output is
// not a TTY (or NO_COLOR is set) so piped logs stay readable.

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

let stepNumber = 0;

/** A numbered top-level step. Resets with resetSteps(). */
export function step(title) {
  stepNumber += 1;
  process.stdout.write(`\n${color.bold(`[${stepNumber}] ${title}`)}\n`);
}

export function resetSteps() {
  stepNumber = 0;
}

/** Something was created or changed. */
export const ok = (msg) => console.log(`  ${color.green('✓')} ${msg}`);

/** Already in the desired state — nothing to do. */
export const skip = (msg) => console.log(`  ${color.dim('·')} ${color.dim(msg)}`);

/** Worth reading, but not a failure. */
export const warn = (msg) => console.log(`  ${color.yellow('!')} ${msg}`);

/** A step failed; the run continues but a manual follow-up is needed. */
export const fail = (msg) => console.log(`  ${color.red('✗')} ${msg}`);

export const info = (msg) => console.log(`  ${msg}`);
export const plain = (msg = '') => console.log(msg);

export function heading(msg) {
  console.log(`\n${color.bold(msg)}`);
}

/** Fatal: print and exit non-zero. Used for unrecoverable input errors. */
export function die(msg) {
  console.error(`\n${color.red('error')} ${msg}\n`);
  process.exit(1);
}
