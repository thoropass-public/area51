// Interactive prompts, built on node:readline/promises.
//
// Every prompt honors --yes / A51_YES=1 (non-interactive mode): ask() returns
// the default, confirm() returns true, and select() takes the first choice. A
// prompt with no usable default in non-interactive mode is a fatal error, so an
// unattended run never silently guesses something important.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { die, color } from './log.mjs';

let assumeYes = false;
export function setAssumeYes(value) {
  assumeYes = Boolean(value);
}
export function isAssumeYes() {
  return assumeYes;
}

let rl = null;
function iface() {
  if (!rl) rl = createInterface({ input: stdin, output: stdout });
  return rl;
}
export function closePrompts() {
  if (rl) {
    rl.close();
    rl = null;
  }
}

/** Free-text question. `def` is used as-is when the answer is empty. */
export async function ask(question, def = '', { required = false } = {}) {
  if (assumeYes) {
    if (!def && required) die(`--yes was passed but "${question}" has no default value.`);
    return def;
  }
  const suffix = def ? ` ${color.dim(`[${def}]`)}` : '';
  for (;;) {
    const answer = (await iface().question(`${question}${suffix}: `)).trim();
    const value = answer || def;
    if (value || !required) return value;
    console.log(color.yellow('  a value is required'));
  }
}

/** Yes/no. `def` is the answer used for a bare Enter and for --yes. */
export async function confirm(question, def = true) {
  if (assumeYes) return true;
  const hint = def ? 'Y/n' : 'y/N';
  for (;;) {
    const answer = (await iface().question(`${question} ${color.dim(`(${hint})`)} `)).trim().toLowerCase();
    if (!answer) return def;
    if (['y', 'yes'].includes(answer)) return true;
    if (['n', 'no'].includes(answer)) return false;
  }
}

/**
 * Pick one of `choices` ({ value, label, hint }). Returns the chosen value.
 * A single-choice list is auto-selected (and announced) rather than prompted.
 */
export async function select(question, choices, { auto = true } = {}) {
  if (!choices.length) die(`nothing to choose from for "${question}".`);
  if (choices.length === 1 && auto) {
    console.log(`  ${question}: ${color.bold(choices[0].label)} ${color.dim('(only option)')}`);
    return choices[0].value;
  }
  if (assumeYes) return choices[0].value;

  console.log(`\n  ${question}`);
  choices.forEach((c, i) => {
    const hint = c.hint ? ` ${color.dim(c.hint)}` : '';
    console.log(`    ${String(i + 1).padStart(2)}) ${c.label}${hint}`);
  });
  for (;;) {
    const answer = (await iface().question(`  choice [1]: `)).trim() || '1';
    const idx = Number(answer);
    if (Number.isInteger(idx) && idx >= 1 && idx <= choices.length) return choices[idx - 1].value;
    console.log(color.yellow(`  enter a number between 1 and ${choices.length}`));
  }
}

/**
 * Destructive-action gate: the user must type the exact word. Never satisfied
 * by --yes — an unattended run must not be able to delete data.
 */
export async function typeToConfirm(word, warning) {
  console.log(`\n${color.red(warning)}`);
  const answer = (await iface().question(`Type ${color.bold(word)} to continue: `)).trim();
  return answer === word;
}
