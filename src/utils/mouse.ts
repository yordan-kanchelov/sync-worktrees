const ESC = String.fromCharCode(27);

/**
 * Normal tracking (button press/release) plus SGR extended reporting. Motion
 * tracking is deliberately left off: the wheel is all this needs, and drag
 * reporting would flood stdin and fight the terminal's own text selection more
 * than press/release already does.
 */
export const MOUSE_TRACKING_ENABLE = `${ESC}[?1000h${ESC}[?1006h`;
export const MOUSE_TRACKING_DISABLE = `${ESC}[?1006l${ESC}[?1000l`;

// ESC [ < button ; column ; row (M press | m release). Ink hands the sequence
// to useInput with the leading ESC already stripped, but the raw form is
// accepted too so this does not silently break if that changes.
const SGR_MOUSE_PATTERN = new RegExp(`^(?:${ESC})?\\[<(\\d+);(\\d+);(\\d+)[Mm]$`);

const WHEEL_FLAG = 0b100_0000;
const BUTTON_MASK = 0b11;

export type WheelDirection = "up" | "down";

/**
 * Ink delivers an unrecognized CSI sequence to `useInput` whole, so mouse
 * reports arrive as a single `input` string rather than as loose characters.
 * Any component that appends `input` to text (filters, name fields) has to skip
 * them, or a scroll lands in the box as garbage.
 *
 * Matches the complete report rather than just its prefix: typed characters
 * reach `useInput` one at a time and pasted text goes through `usePaste`, so
 * nothing a person can type is mistaken for a mouse event.
 */
export function isMouseSequence(input: string): boolean {
  return SGR_MOUSE_PATTERN.test(input);
}

/**
 * Wheel direction for a scroll report, or null for anything else — clicks,
 * horizontal wheel, and non-mouse input all fall through so the caller's normal
 * key handling still runs.
 */
export function parseWheelEvent(input: string): WheelDirection | null {
  const match = SGR_MOUSE_PATTERN.exec(input);
  if (!match) return null;

  const button = Number.parseInt(match[1], 10);
  if (!Number.isFinite(button) || (button & WHEEL_FLAG) === 0) return null;

  // Modifier bits (shift/meta/ctrl) ride along in the same field, so compare
  // only the button bits: 0 is wheel up, 1 wheel down, 2/3 horizontal.
  switch (button & BUTTON_MASK) {
    case 0:
      return "up";
    case 1:
      return "down";
    default:
      return null;
  }
}
