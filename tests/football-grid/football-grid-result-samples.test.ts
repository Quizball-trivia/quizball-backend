import { describe, expect, it } from "vitest";
import {
  selectDiverseFootballGridSamples,
  type FootballGridCuratedSampleCandidate,
} from "../../src/modules/football-grid/football-grid.repo.js";

function candidate(
  cellIndex: number,
  playerId: string,
): FootballGridCuratedSampleCandidate {
  return {
    cellIndex,
    playerId,
    name: `Player ${playerId}`,
    imageAssetKey: `players/${playerId}.webp`,
  };
}

describe("selectDiverseFootballGridSamples", () => {
  it("prefers different recognizable players across cells", () => {
    const shared = ["zlatan", "silva", "verratti", "pastore", "coman"];
    const candidates = [0, 1, 2].flatMap((cellIndex) => [
      ...shared.map((playerId) => candidate(cellIndex, playerId)),
      ...Array.from({ length: 5 }, (_, index) =>
        candidate(cellIndex, `cell-${cellIndex}-${index}`),
      ),
    ]);

    const result = selectDiverseFootballGridSamples(candidates, 5);
    const exposedIds = result.flatMap((cell) =>
      cell.players.map((player) => player.playerId),
    );

    expect(result).toHaveLength(3);
    expect(result.every((cell) => cell.players.length === 5)).toBe(true);
    expect(new Set(exposedIds).size).toBe(15);
    expect(result[0].players[0].playerId).toBe("zlatan");
    expect(result[1].players[0].playerId).toBe("silva");
    expect(result[2].players[0].playerId).toBe("verratti");
  });

  it("repeats a player only when a cell has no unused alternative", () => {
    const result = selectDiverseFootballGridSamples(
      [
        candidate(0, "shared"),
        candidate(0, "cell-0"),
        candidate(1, "shared"),
        candidate(1, "cell-1"),
      ],
      2,
    );

    expect(
      result.map((cell) => cell.players.map((player) => player.playerId)),
    ).toEqual([
      ["shared", "cell-0"],
      ["cell-1", "shared"],
    ]);
  });
});
