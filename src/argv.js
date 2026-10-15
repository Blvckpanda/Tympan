/**
 * argv.js — pure argument parsing for the CLI.
 *
 * Kept out of bin/tympan.js so flag/value disambiguation (which is what tells
 * a batch how many inputs it has) is unit-testable without spawning a process,
 * and so the CLI stays an orchestration script. No I/O, no process access:
 * parse returns data plus `errors`, and the caller decides how to shout.
 *
 * Supported spellings: `--flag value`, `--flag=value`, repeatable flags, and
 * `--` to end flag parsing (weird filenames). A lone `-` is a positional —
 * in tympan it means stdin, so it must never be mistaken for a flag. Unknown
 * options are collected as errors rather than ignored: silently dropping a
 * typo'd flag is how a CI job passes while converting the wrong thing.
 */

/**
 * @param {string[]} argv arguments after the node/script pair
 * @param {object} spec
 * @param {string[]} spec.valued flags taking one value
 * @param {string[]} spec.repeatable valued flags that accumulate
 * @param {string[]} spec.boolean flags taking no value
 * @returns {{positionals: string[], errors: string[],
 *   has(name: string): boolean, value(name: string): string|undefined,
 *   list(name: string): string[]}}
 */
export function parseArgv(argv, spec = {}) {
  const valued = new Set(spec.valued || []);
  const repeatable = new Set(spec.repeatable || []);
  const boolean = new Set(spec.boolean || []);
  const values = new Map();
  const lists = new Map();
  const flags = new Set();
  const positionals = [];
  const errors = [];
  let noMoreFlags = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (noMoreFlags) {
      positionals.push(arg);
      continue;
    }
    if (arg === '--') {
      noMoreFlags = true;
      continue;
    }
    // `-` is stdin (a positional), not a flag; a bare `-` can never be one.
    if (arg === '-' || !arg.startsWith('-')) {
      positionals.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    const name = eq > 0 ? arg.slice(0, eq) : arg;
    const inline = eq > 0 ? arg.slice(eq + 1) : undefined;

    if (boolean.has(name)) {
      if (inline !== undefined) errors.push(`${name} does not take a value`);
      else flags.add(name);
      continue;
    }
    // Repeatable flags are valued flags that accumulate.
    if (valued.has(name) || repeatable.has(name)) {
      let value = inline;
      if (value === undefined) {
        value = argv[i + 1];
        if (value === undefined || (value.startsWith('-') && value !== '-')) {
          errors.push(`missing value for ${name}`);
          continue;
        }
        i++;
      }
      if (repeatable.has(name)) lists.set(name, [...(lists.get(name) || []), value]);
      else values.set(name, value);
      continue;
    }
    errors.push(`unknown option: ${name}`);
  }

  return {
    positionals,
    errors,
    has: (name) => flags.has(name) || values.has(name) || lists.has(name),
    value: (name) => values.get(name),
    list: (name) => lists.get(name) || [],
  };
}
