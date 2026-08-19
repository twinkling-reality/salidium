/**
 * Agents write markdown. Everything the claims layer reads can arrive with `**`, `##`, backticks
 * and fences in it; those markers must not leak directly into the page.
 *
 * Two different jobs, and they must happen in this order:
 *
 * 1. `markdownShape` reads the *structure*, which is evidence about what the text is. A heading is
 *    a document's furniture, not a sentence anyone asserted; a fenced block is evidence; a line
 *    that is entirely bold is a header — which is how Codex reasoning records are wrapped. Those
 *    records are not claims, and the
 *    reason they are not is structural rather than a per-provider exception.
 * 2. `plainText` then flattens what is left, because once the structure has been read the markers
 *    are noise to a reader who is being shown a quoted sentence.
 *
 * Flattening before reading the shape would lose the evidence; showing the text without
 * flattening is what this app exists to spare a reader.
 */

/** Fenced blocks, and the indented-four-spaces form, are code rather than narration. */
const FENCE = /(^|\n)\s*(```|~~~)/;

/**
 * A tool call or a machine record that landed in a text field: `visualize{"path":…}`, a bare JSON
 * object, or an XML-ish tag. These are artifacts rather than claims.
 */
const TOOL_ARTIFACT = /^(?:[\w-]+\{"|[[{]"|<\/?[a-z][\w-]*[\s>/])/i;

/** A line that is only a path, a URL or a command is a reference, not a statement. */
const BARE_REFERENCE = /^(?:[a-z]+:\/\/\S+|[~./]?[\w./@-]+\.[a-z0-9]{1,6}(?::\d+)?|[$>][^\n]*)$/i;

export interface MarkdownShape {
  /** `# Heading` — furniture. Names a section; asserts nothing about the work. */
  heading: boolean;
  /** The whole segment is `**…**`. A rendered header, which is what a reasoning record is. */
  wholeBold: boolean;
  /** Contains a fenced code block. */
  fence: boolean;
  /** `- item`, `* item`, `1. item`. */
  listItem: boolean;
  /** `> quoted`. */
  quote: boolean;
  /** A `|` table row. */
  table: boolean;
  /** A machine record or a bare path that reached a text field. */
  artifact: boolean;
}

export function markdownShape(raw: string): MarkdownShape {
  const t = raw.trim();
  const firstLine = (t.split('\n', 1)[0] ?? '').trim();
  return {
    heading: /^#{1,6}\s/.test(firstLine),
    wholeBold: /^\*\*[\s\S]+\*\*$/.test(t) && !/\*\*[\s\S]*\*\*[\s\S]*\*\*/.test(t.slice(2, -2)),
    fence: FENCE.test(t),
    listItem: /^(?:[-*+]\s|\d{1,3}[.)]\s)/.test(firstLine),
    quote: /^>\s?/.test(firstLine),
    table: /^\|/.test(firstLine),
    artifact: TOOL_ARTIFACT.test(t) || BARE_REFERENCE.test(firstLine),
  };
}

/** True when the shape says this text is not a sentence someone asserted. */
export function isRenderedFurniture(s: MarkdownShape): boolean {
  return s.heading || s.wholeBold || s.fence || s.table || s.artifact;
}

/**
 * Markdown to the text it renders as, on one line.
 *
 * Deliberately conservative: it removes markers whose only job is formatting and keeps everything
 * else exactly as written, because a claim is relayed verbatim and a "flatten" that paraphrases
 * would break that. Link text is kept and the URL dropped — a reader gets the words, and the
 * record behind the claim still has the address.
 */
export function plainText(md: string): string {
  return (
    md
      // Fenced code is evidence, not prose. An unterminated fence takes the rest of the text.
      .replace(/(?:^|\n)[ \t]*(```|~~~)[^\n]*\n[\s\S]*?\n[ \t]*\1[^\n]*(?=\n|$)/g, ' ')
      .replace(/(?:^|\n)[ \t]*(```|~~~)[\s\S]*$/g, ' ')
      // Images before links: the alt text is the only readable part.
      .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      // Reference links and autolinks.
      .replace(/\[([^\]]+)\]\[[^\]]*\]/g, '$1')
      .replace(/<((?:https?|mailto):[^>\s]+)>/g, '$1')
      // Block markers, per line, before the inline pass.
      .split('\n')
      .map((line) =>
        line
          .replace(/^\s{0,3}#{1,6}\s+/, '')
          .replace(/^\s{0,3}>\s?/, '')
          .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, '')
          .replace(/^\s*([-*_])(?:\s*\1){2,}\s*$/, ''),
      )
      .join('\n')
      // Inline code: keep what is inside, drop the ticks. Longest run first so ``a `b` c`` works.
      .replace(/``([^`]|`(?!`))+``/g, (m) => m.slice(2, -2))
      .replace(/`([^`\n]+)`/g, '$1')
      // A backtick still standing after that pass has no partner in this text — its span opened or
      // closed somewhere the segmenter cut. It can only be a marker, never content, so it goes;
      // the same is not true of `*`, which is arithmetic and appears in real URLs.
      .replace(/`/g, '')
      // Emphasis, only where it is paired and not hugging whitespace — so `2 * 3 * 4` and
      // snake_case_identifiers survive, which is why this is not a blanket strip of `*` and `_`.
      .replace(/~~(?=\S)([\s\S]*?\S)~~/g, '$1')
      .replace(/\*\*\*(?=\S)([\s\S]*?\S)\*\*\*/g, '$1')
      .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, '$1')
      .replace(/(?<![\w*])\*(?=\S)([^*\n]*?\S)\*(?![\w*])/g, '$1')
      .replace(/(?<![\w_])__(?=\S)([\s\S]*?\S)__(?![\w_])/g, '$1')
      .replace(/(?<![\w_])_(?=\S)([^_\n]*?\S)_(?![\w_])/g, '$1')
      // Escapes last, so `\*` written literally survives the emphasis pass above.
      .replace(/\\([\\`*_{}[\]()#+\-.!>~|])/g, '$1')
      .replace(/\s+/g, ' ')
      .trim()
  );
}
