import { normalizeRideCode, RIDE_CODE_LENGTH } from '@intercom/shared';

const LINK = /\/r\/([A-Za-z0-9-]{1,32})/;

/** Pulls a ride code out of whatever was typed or pasted: "abc-d23", "ABC D23" or a full join link. */
export function extractRideCode(input: string): string {
  const fromLink = LINK.exec(input);
  return normalizeRideCode(fromLink ? fromLink[1]! : input).slice(0, RIDE_CODE_LENGTH);
}

/** True when the input contains characters codes never use (0/O, 1/I/L), so we can say why they vanished. */
export function hasLookalikes(input: string): boolean {
  return !LINK.test(input) && /[0O1IL]/i.test(input);
}

/** "ABCD" -> "ABC-D": the same grouping as formatRideCode, applied while the code is still partial. */
export function formatPartialCode(code: string): string {
  return code.length > 3 ? `${code.slice(0, 3)}-${code.slice(3)}` : code;
}
