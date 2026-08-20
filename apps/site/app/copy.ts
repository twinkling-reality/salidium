"use client";

import { useEffect, useRef, useState } from "react";

/*
 * Copying a command to the clipboard, in one place. The home page card and the install block in
 * the docs answer a click differently, but they answer it on the same clock and with the same
 * three states, and the part that is easy to get wrong is the same for both.
 */

export type CopyState = "idle" | "copied" | "failed";
export type CopyAnswer = Exclude<CopyState, "idle">;

/*
 * How long a control holds its answer before handing itself back. This is a dwell, not a motion
 * duration: the two tokens in `scale.css` govern how long a change takes, and nothing there
 * governs how long a finished state stays up. Long enough to read six words, short enough that a
 * reader who has already moved to their terminal does not come back to a control still
 * congratulating itself.
 */
export const DWELL = 2400;

export function useCopy(text: string): {
  state: CopyState;
  /*
   * The last answer given, kept after the state has gone back to idle. Returning to rest is a
   * fade, and a fade needs something to fade out: a control that reads its wording off `state`
   * blanks itself in the frame the state resets, leaving an empty box to animate and the reader
   * watching words disappear rather than recede.
   */
  answered: CopyAnswer;
  copy: () => void;
} {
  const [state, setState] = useState<CopyState>("idle");
  const [answered, setAnswered] = useState<CopyAnswer>("copied");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timer.current), []);

  async function copy() {
    /*
     * writeText rejects on an insecure origin, on a denied permission, in an unfocused tab, and in
     * Safari when the write escapes the user gesture. This used to be an unguarded await, so the
     * rejection skipped the state update and the button did nothing at all, silently, forever.
     */
    let next: CopyAnswer;
    try {
      await navigator.clipboard.writeText(text);
      next = "copied";
    } catch {
      next = "failed";
    }
    setAnswered(next);
    setState(next);
    /*
     * One timer, restarted rather than added to. Each click used to start its own, so a second
     * click inherited whatever was left of the first click's dwell and its answer was cut short.
     */
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), DWELL);
  }

  return { state, answered, copy };
}
