/**
 * Missing XI pitch layout repair.
 *
 * The pitch is drawn vertically with the team's own goal at the bottom, so the
 * team's left flank is on the left of the screen (small `x`).
 *
 * Squads verified against UEFA (`verified.source === 'uefa'`) had their layout
 * rebuilt from UEFA's line-up graphic, which draws the team attacking DOWN the
 * screen. The content script used UEFA's `x` as-is, so every such squad was
 * mirrored: right-backs (Carvajal) were drawn and labelled LB, left-backs
 * (Marcelo) RB, Ronaldo on the right wing, and so on. Their position codes were
 * derived purely from where each player sat in that graphic, so the layout can
 * be rebuilt from the stored geometry alone: mirror `x`, regroup the lines by
 * `y`, and re-label each line.
 *
 * Payloads written by the fixed content script carry `layout_version >= 2` and
 * are served untouched.
 */

export const MISSING_XI_LAYOUT_VERSION = 2;

export interface MissingXiLayoutSlot {
  position: string;
  x: number;
  y: number;
}

export interface MissingXiLayoutPayload<TSlot extends MissingXiLayoutSlot> {
  slots: TSlot[];
  verified?: { source: string } | null;
  layout_version?: number | null;
}

export function needsMissingXiLayoutRepair(payload: MissingXiLayoutPayload<MissingXiLayoutSlot>): boolean {
  return payload.verified?.source === 'uefa' && (payload.layout_version ?? 1) < MISSING_XI_LAYOUT_VERSION;
}

/**
 * Position code for the player at index `j` (left to right) of a line of `n`,
 * in line `lineIdx` (0 = back line) out of `lineSizes`. Only genuinely wide
 * players get a side: a back four's full-backs, a front three's wingers, a flat
 * midfield four/five's wide men. A double pivot, a back three or the pair
 * behind a front three are central roles, not "LW/RW".
 */
export function missingXiLineCode(lineIdx: number, j: number, n: number, lineSizes: number[]): string {
  const last = lineSizes.length - 1;
  const mids = lineSizes.length - 2;
  const front = lineSizes[last] ?? 1;
  const isEdge = j === 0 || j === n - 1;
  const side = j === 0 ? 'L' : 'R';

  if (lineIdx === 0) return n >= 4 && isEdge ? `${side}B` : 'CB';
  if (lineIdx === last) return n >= 3 && isEdge ? `${side}W` : 'CF';
  // Deepest of several midfield lines: a holding pair/single, or a flat four.
  if (mids >= 2 && lineIdx === 1) {
    if (n >= 4) return isEdge ? `${side}M` : 'CM';
    return n <= 2 ? 'DM' : 'CM';
  }
  // Line just behind the forwards: an attacking-midfield line with wingers
  // when the front line is a lone striker; plain midfielders behind a front three.
  if (mids >= 2 && lineIdx === last - 1) {
    if (n >= 3 && isEdge) return front <= 1 ? `${side}W` : `${side}M`;
    return front >= 3 ? 'CM' : 'AM';
  }
  return n >= 4 && isEdge ? `${side}M` : 'CM';
}

/** Mirror a UEFA-sourced XI back onto the team's real flanks and re-label it. */
export function repairMissingXiLayout<TSlot extends MissingXiLayoutSlot>(slots: TSlot[]): TSlot[] {
  const outfield = slots.filter((slot) => slot.position !== 'GK');
  // Lines were drawn at one fixed y each; the back line is nearest the goal (largest y).
  const ys = Array.from(new Set(outfield.map((slot) => slot.y))).sort((a, b) => b - a);
  const lines = ys.map((y) =>
    outfield
      .filter((slot) => slot.y === y)
      .map((slot) => ({ slot, x: 100 - slot.x }))
      .sort((a, b) => a.x - b.x)
  );
  const lineSizes = lines.map((line) => line.length);
  const repaired = new Map<TSlot, TSlot>();
  lines.forEach((line, lineIdx) => {
    line.forEach(({ slot, x }, j) => {
      repaired.set(slot, { ...slot, x, position: missingXiLineCode(lineIdx, j, line.length, lineSizes) });
    });
  });
  // Keep the stored slot order (ids, keys and the reveal stagger stay stable).
  return slots.map((slot) => repaired.get(slot) ?? slot);
}

export function missingXiServedSlots<TSlot extends MissingXiLayoutSlot>(payload: MissingXiLayoutPayload<TSlot>): TSlot[] {
  return needsMissingXiLayoutRepair(payload) ? repairMissingXiLayout(payload.slots) : payload.slots;
}
