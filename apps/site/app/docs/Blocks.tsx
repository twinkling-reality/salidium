import type { ReactNode } from "react";
import { CopyCommand } from "./DocsChrome";
import type { Block } from "./content";
import SHOTS from "./shots.json";

type Shot = { width: number; height: number; light: string; dark: string };

/*
 * `code`, **bold** and [links](/to) in one pass, so a sentence is written once and rendered to both
 * the page and the Markdown. Deliberately not a Markdown library: this is the whole of the inline
 * syntax the documentation uses, and a parser for it is a dozen lines.
 */
const TOKEN = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[[^\]]+\]\([^)]+\))/g;
const LINK = /^\[([^\]]+)\]\(([^)]+)\)$/;

export function Inline({ text }: { text: string }): ReactNode {
  return text.split(TOKEN).map((part, i) => {
    if (part.startsWith("`") && part.endsWith("`")) return <code key={i}>{part.slice(1, -1)}</code>;
    if (part.startsWith("**") && part.endsWith("**"))
      return <strong key={i}>{part.slice(2, -2)}</strong>;
    const link = LINK.exec(part);
    if (link)
      return (
        <a className="doc-link" href={link[2]} key={i}>
          {link[1]}
        </a>
      );
    if (part.startsWith("*") && part.endsWith("*")) return <em key={i}>{part.slice(1, -1)}</em>;
    return part;
  });
}

export function Blocks({ blocks }: { blocks: Block[] }) {
  return blocks.map((block, i) => {
    switch (block.kind) {
      case "p":
        return (
          <p key={i}>
            <Inline text={block.text} />
          </p>
        );
      case "h":
        return <h2 key={i}>{block.text}</h2>;
      case "note":
        return (
          <p className="doc-note" key={i}>
            <Inline text={block.text} />
          </p>
        );
      case "list":
        return (
          <ul key={i}>
            {block.items.map((item, j) => (
              <li key={j}>
                <Inline text={item} />
              </li>
            ))}
          </ul>
        );
      case "command":
        return <CopyCommand command={block.command} key={i} />;
      case "shot": {
        /*
         * A capture of the running product, taken by `scripts/capture-docs.mjs` against a real
         * daemon and clipped to the surface this page describes.
         *
         * `srcset` with a `2x` descriptor rather than a width from the manifest: the file is
         * captured at twice its size, and this is how a picture says so. The browser then draws it
         * at half its own pixels, which means it can never be scaled up past its true size even if
         * the file on disk is not the one the manifest was written for. Sizing it from a number
         * held somewhere else is what let a stale capture be stretched into a box meant for a
         * different one.
         *
         * The names carry a hash of their bytes, so a changed capture is a changed name and no
         * cache can serve the old picture at the new size.
         *
         * Both themes are in the markup and the stylesheet shows one, because a
         * `prefers-color-scheme` picture would ignore the theme the reader actually chose. Both
         * carry the same description: the hidden one is removed from the tree by `display: none`,
         * so nobody meets it twice, and marking the dark one decorative left every capture on the
         * site describing itself to nobody whenever dark was the theme in use.
         */
        const s = (SHOTS as Record<string, Shot>)[block.name];
        if (!s) return null;
        return (
          <figure className={block.cropped ? "doc-shot is-cropped" : "doc-shot"} key={i}>
            <img
              className="shot-light"
              src={`/docs/${s.light}`}
              srcSet={`/docs/${s.light} 2x`}
              alt={block.alt}
              width={s.width}
              height={s.height}
            />
            <img
              className="shot-dark"
              src={`/docs/${s.dark}`}
              srcSet={`/docs/${s.dark} 2x`}
              alt={block.alt}
              width={s.width}
              height={s.height}
            />
          </figure>
        );
      }
      case "keys":
        /*
         * A shortcut is a key, and it has to look like one. Set as body text, a lone `h` on its own
         * line reads as a typo rather than as the thing you press.
         */
        return (
          <dl className="doc-terms doc-keys" key={i}>
            {block.items.map(([ks, meaning]) => (
              <div key={ks.join()}>
                <dt>
                  {ks.map((k) => (
                    <kbd key={k}>{k}</kbd>
                  ))}
                </dt>
                <dd>{meaning}</dd>
              </div>
            ))}
          </dl>
        );
      case "terms":
        return (
          <dl className="doc-terms" key={i}>
            {block.items.map(([name, meaning]) => (
              <div key={name}>
                <dt>
                  <Inline text={name} />
                </dt>
                <dd>
                  <Inline text={meaning} />
                </dd>
              </div>
            ))}
          </dl>
        );
    }
  });
}
