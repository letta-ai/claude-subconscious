import type { ContextChannel } from "./types.js";

/**
 * The boundaries every supported harness reads plain stdout on.
 *
 * An adapter starts here and overrides only where its harness proves it can do
 * more, so the override is the interesting part of the file rather than the
 * baseline being restated three times.
 */
export function defaultContextChannel(
  nativeEvent: string,
): ContextChannel | null {
  return nativeEvent === "SessionStart" || nativeEvent === "UserPromptSubmit"
    ? "stdout"
    : null;
}
