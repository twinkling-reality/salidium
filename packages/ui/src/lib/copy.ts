/**
 * Put text on the clipboard, or say that it could not be.
 *
 * Loopback is a secure context and the permission is granted, so this normally just works — but
 * `writeText` rejects with `NotAllowedError` whenever the document does not hold focus, which is a
 * state a real window gets into too. A control that silently does nothing is the worst of the
 * options, so the refusal is reported and the caller can select the text instead and let the
 * keyboard finish the job. The auth gate does the same thing by hand and predates this; it should
 * compose this function.
 */
export async function copyText(text: string): Promise<'copied' | 'refused'> {
  if (!navigator.clipboard) return 'refused';
  try {
    await navigator.clipboard.writeText(text);
    return 'copied';
  } catch {
    return 'refused';
  }
}

/** Selects an element's text, so a refused copy still leaves the reader one keystroke away. */
export function selectNode(el: HTMLElement | null): void {
  if (!el) return;
  const range = document.createRange();
  range.selectNodeContents(el);
  const sel = window.getSelection();
  sel?.removeAllRanges();
  sel?.addRange(range);
}
