// Interactive prompts, built on node:readline/promises.
//
// There is deliberately NO unattended mode. There used to be a --yes / A51_YES=1
// flag that made ask() return its default, confirm() return true and select()
// take the first choice — and it was a liability. Every one of these prompts sits
// in front of something that provisions or destroys live infrastructure, and the
// worst case was concrete: on a fresh install --yes skipped the Access allow-list
// prompt and shipped a world-readable dashboard, because "no default" quietly
// became "no protection".
//
// So the answers are always typed by a person. The commands that only read or
// upload (`status`, `doctor`, `deploy`, `tail`) never call anything in this file,
// so those stay scriptable; the ones that change infrastructure need a terminal,
// and say so rather than hanging when they do not have one.

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { die, color } from './log.mjs';

let rl = null;
function iface() {
  if (!rl) {
    // Without a TTY there is nobody to answer, and a `required` prompt would
    // otherwise spin forever on end-of-input. Fail with the reason instead.
    if (!stdin.isTTY) {
      die([
        'this command needs an interactive terminal.',
        '',
        '  AREA 51 has no unattended mode. Every prompt here guards something that',
        '  provisions or destroys live infrastructure, so the answers are always',
        '  typed by a person. Run it from a terminal you are sitting at.',
        '',
        '  Scriptable without a terminal: status, doctor, deploy, tail.',
      ].join('\n'));
    }
    rl = createInterface({ input: stdin, output: stdout });
  }
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
  const suffix = def ? ` ${color.dim(`[${def}]`)}` : '';
  for (;;) {
    const answer = (await iface().question(`${question}${suffix}: `)).trim();
    const value = answer || def;
    if (value || !required) return value;
    console.log(color.yellow('  a value is required'));
  }
}

/** Yes/no. `def` is the answer used for a bare Enter. */
export async function confirm(question, def = true) {
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
 * Destructive-action gate: the operator must type the exact word. A bare Enter,
 * a wrong word, or anything pasted by accident all decline.
 */
export async function typeToConfirm(word, warning) {
  console.log(`\n${color.red(warning)}`);
  const answer = (await iface().question(`Type ${color.bold(word)} to continue: `)).trim();
  return answer === word;
}
