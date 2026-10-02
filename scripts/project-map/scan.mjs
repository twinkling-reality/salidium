/*
 * Module specifiers written in a JavaScript or TypeScript source, found by syntax alone.
 *
 * A small tokenizer skips comments, strings, template text and regular expression literals, so an
 * `import` inside any of them is never mistaken for one in code. Only a specifier written as a
 * plain string literal is returned; `import(someVariable)` is counted, not guessed. Every result is
 * something the file says, which is why the map can call the edges built from them observed.
 */

const REGEX_AFTER_WORD = new Set([
  'return',
  'typeof',
  'case',
  'do',
  'else',
  'in',
  'of',
  'new',
  'delete',
  'void',
  'throw',
  'instanceof',
  'yield',
  'await',
]);
const REGEX_AFTER_PUNCT = new Set('(,=:[!&|?{};+-*%<>~^'.split(''));

/**
 * @typedef {{ type: 'id' | 'str' | 'punct' | 'other', value: string, line: number }} Token
 */

/** @param {string} source @returns {Token[]} */
export function tokenize(source) {
  /** @type {Token[]} */
  const tokens = [];
  /** Brace depth at which each open `${` of a template literal resumes its template text. */
  const templates = [];
  let depth = 0;
  let line = 1;
  let i = 0;
  const n = source.length;

  const regexAllowed = () => {
    const last = tokens.at(-1);
    if (!last) return true;
    if (last.type === 'punct') return REGEX_AFTER_PUNCT.has(last.value);
    if (last.type === 'id') return REGEX_AFTER_WORD.has(last.value);
    return false;
  };

  /** Reads template text from i (just after ` or a closing }) to the end or to the next `${`. */
  const templateText = () => {
    while (i < n) {
      const c = source[i];
      if (c === '\\') {
        i += 2;
        continue;
      }
      if (c === '\n') line += 1;
      if (c === '`') {
        i += 1;
        tokens.push({ type: 'other', value: 'template', line });
        return;
      }
      if (c === '$' && source[i + 1] === '{') {
        i += 2;
        templates.push(depth);
        depth += 1;
        tokens.push({ type: 'punct', value: '(', line });
        return;
      }
      i += 1;
    }
  };

  while (i < n) {
    const c = source[i];
    if (c === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (c === ' ' || c === '\t' || c === '\r') {
      i += 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '/') {
      while (i < n && source[i] !== '\n') i += 1;
      continue;
    }
    if (c === '/' && source[i + 1] === '*') {
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) {
        if (source[i] === '\n') line += 1;
        i += 1;
      }
      i += 2;
      continue;
    }
    if (c === "'" || c === '"') {
      const start = line;
      let value = '';
      i += 1;
      while (i < n && source[i] !== c && source[i] !== '\n') {
        if (source[i] === '\\') {
          value += source.slice(i, i + 2);
          i += 2;
          continue;
        }
        value += source[i];
        i += 1;
      }
      i += 1;
      tokens.push({ type: 'str', value, line: start });
      continue;
    }
    if (c === '`') {
      i += 1;
      templateText();
      continue;
    }
    if (c === '/' && regexAllowed()) {
      i += 1;
      let inClass = false;
      while (i < n && source[i] !== '\n') {
        const r = source[i];
        if (r === '\\') {
          i += 2;
          continue;
        }
        if (r === '[') inClass = true;
        else if (r === ']') inClass = false;
        else if (r === '/' && !inClass) break;
        i += 1;
      }
      i += 1;
      while (i < n && /[a-z]/i.test(source[i] ?? '')) i += 1;
      tokens.push({ type: 'other', value: 'regex', line });
      continue;
    }
    if (/[A-Za-z_$\u0080-￿]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_$\u0080-￿]/.test(source[j] ?? '')) j += 1;
      tokens.push({ type: 'id', value: source.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9A-Za-z_.]/.test(source[j] ?? '')) j += 1;
      tokens.push({ type: 'other', value: 'number', line });
      i = j;
      continue;
    }
    if (c === '{') depth += 1;
    if (c === '}') {
      if (templates.length > 0 && templates.at(-1) === depth - 1) {
        templates.pop();
        depth -= 1;
        i += 1;
        tokens.push({ type: 'punct', value: ')', line });
        templateText();
        continue;
      }
      depth -= 1;
    }
    // `?.` is member access, not a conditional followed by a number.
    if (c === '?' && source[i + 1] === '.' && !/[0-9]/.test(source[i + 2] ?? '')) {
      tokens.push({ type: 'punct', value: '.', line });
      i += 2;
      continue;
    }
    tokens.push({ type: 'punct', value: c, line });
    i += 1;
  }
  return tokens;
}

/**
 * @typedef {'import' | 'import-type' | 'side-effect' | 'export-from' | 'export-type-from' | 'dynamic' | 'require'} SpecifierKind
 * @typedef {{ specifier: string, kind: SpecifierKind, line: number }} Specifier
 */

/**
 * @param {string} source
 * @returns {{ specifiers: Specifier[], dynamicWithoutLiteral: number }}
 */
export function scanSpecifiers(source) {
  const tokens = tokenize(source);
  /** @type {Specifier[]} */
  const specifiers = [];
  let dynamicWithoutLiteral = 0;
  const at = (k) => tokens[k];
  const is = (k, type, value) =>
    at(k)?.type === type && (value === undefined || at(k)?.value === value);

  /** From k, the index of the string after `from` at brace depth zero, or -1. */
  const fromClause = (k, limit = 4000) => {
    let braces = 0;
    for (let j = k; j < tokens.length && j < k + limit; j += 1) {
      const t = tokens[j];
      if (t.type === 'punct' && t.value === '{') braces += 1;
      else if (t.type === 'punct' && t.value === '}') braces -= 1;
      else if (t.type === 'punct' && (t.value === ';' || t.value === '=' || t.value === '('))
        return -1;
      else if (braces === 0 && t.type === 'id' && t.value === 'from' && is(j + 1, 'str'))
        return j + 1;
      else if (
        braces === 0 &&
        t.type === 'id' &&
        j > k &&
        (t.value === 'import' || t.value === 'export')
      )
        return -1;
    }
    return -1;
  };

  /** Every named specifier in `{ ... }` starting at k is marked `type`, and there is nothing else. */
  const onlyTypeNames = (k, end) => {
    if (!is(k, 'punct', '{')) return false;
    let names = 0;
    let typed = 0;
    let expectName = true;
    for (let j = k + 1; j < end; j += 1) {
      const t = tokens[j];
      if (t.type === 'punct' && t.value === '}')
        return names > 0 && names === typed && is(j + 1, 'id', 'from');
      if (t.type === 'punct' && t.value === ',') {
        expectName = true;
        continue;
      }
      if (expectName) {
        names += 1;
        if (
          t.type === 'id' &&
          t.value === 'type' &&
          !is(j + 1, 'punct', ',') &&
          !is(j + 1, 'punct', '}') &&
          !is(j + 1, 'id', 'as')
        )
          typed += 1;
        expectName = false;
      }
    }
    return false;
  };

  for (let k = 0; k < tokens.length; k += 1) {
    const t = tokens[k];
    if (t.type !== 'id') continue;
    const afterDot = is(k - 1, 'punct', '.');
    if (afterDot) continue;

    if (t.value === 'import') {
      if (is(k + 1, 'punct', '.')) continue; // import.meta
      if (is(k + 1, 'punct', '(')) {
        if (is(k + 2, 'str') && (is(k + 3, 'punct', ')') || is(k + 3, 'punct', ','))) {
          // `import('x').Page` and `typeof import('x')` are TypeScript type queries: a runtime
          // import is a promise, so a member other than then, catch or finally cannot follow it.
          const member = is(k + 4, 'punct', '.') ? at(k + 5)?.value : undefined;
          const typeQuery =
            is(k - 1, 'id', 'typeof') ||
            (member !== undefined && !['then', 'catch', 'finally'].includes(member));
          specifiers.push({
            specifier: at(k + 2).value,
            kind: typeQuery ? 'import-type' : 'dynamic',
            line: t.line,
          });
        } else dynamicWithoutLiteral += 1;
        continue;
      }
      if (is(k + 1, 'str')) {
        specifiers.push({ specifier: at(k + 1).value, kind: 'side-effect', line: t.line });
        continue;
      }
      const str = fromClause(k + 1);
      if (str < 0) continue;
      const typeKeyword =
        is(k + 1, 'id', 'type') && !is(k + 2, 'id', 'from') && !is(k + 2, 'punct', ',');
      const kind = typeKeyword || onlyTypeNames(k + 1, str) ? 'import-type' : 'import';
      specifiers.push({ specifier: at(str).value, kind, line: t.line });
      k = str;
      continue;
    }

    if (t.value === 'export') {
      let j = k + 1;
      const typeKeyword =
        is(j, 'id', 'type') && (is(j + 1, 'punct', '{') || is(j + 1, 'punct', '*'));
      if (typeKeyword) j += 1;
      if (!is(j, 'punct', '{') && !is(j, 'punct', '*')) continue;
      const str = fromClause(j);
      if (str < 0) continue;
      const kind = typeKeyword || onlyTypeNames(j, str) ? 'export-type-from' : 'export-from';
      specifiers.push({ specifier: at(str).value, kind, line: t.line });
      k = str;
      continue;
    }

    if (
      t.value === 'require' &&
      is(k + 1, 'punct', '(') &&
      is(k + 2, 'str') &&
      is(k + 3, 'punct', ')')
    ) {
      specifiers.push({ specifier: at(k + 2).value, kind: 'require', line: t.line });
    }
  }
  return { specifiers, dynamicWithoutLiteral };
}
