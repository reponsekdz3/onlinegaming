export type PlayerMark = "X" | "O";
export type Cell = PlayerMark | null;
export type MatchStatus = "IN_PROGRESS" | "COMPLETED" | "DRAW";

export interface TicTacToeState {
  readonly board: readonly Cell[];
  readonly currentTurn: PlayerMark;
  readonly status: MatchStatus;
  readonly winner: PlayerMark | null;
  readonly moveCount: number;
}

const WINNING_LINES: readonly (readonly [number, number, number])[] = [
  [0, 1, 2], [3, 4, 5], [6, 7, 8],
  [0, 3, 6], [1, 4, 7], [2, 5, 8],
  [0, 4, 8], [2, 4, 6]
];

export function createTicTacToeState(): TicTacToeState {
  return Object.freeze({
    board: Object.freeze(Array<Cell>(9).fill(null)),
    currentTurn: "X",
    status: "IN_PROGRESS",
    winner: null,
    moveCount: 0
  });
}

export function applyTicTacToeMove(
  state: TicTacToeState,
  player: PlayerMark,
  cellIndex: number
): TicTacToeState {
  if (state.status !== "IN_PROGRESS") throw new Error("MATCH_ALREADY_FINISHED");
  if (!Number.isInteger(cellIndex) || cellIndex < 0 || cellIndex > 8) throw new Error("INVALID_CELL");
  if (state.currentTurn !== player) throw new Error("NOT_PLAYERS_TURN");
  if (state.board[cellIndex] !== null) throw new Error("CELL_ALREADY_OCCUPIED");

  const nextBoard = [...state.board];
  nextBoard[cellIndex] = player;
  const winningLine = WINNING_LINES.find(([a, b, c]) =>
    nextBoard[a] !== null && nextBoard[a] === nextBoard[b] && nextBoard[b] === nextBoard[c]
  );
  const winner = winningLine ? player : null;
  const moveCount = state.moveCount + 1;
  const status = winner ? "COMPLETED" : moveCount === 9 ? "DRAW" : "IN_PROGRESS";
  return Object.freeze({
    board: Object.freeze(nextBoard),
    currentTurn: player === "X" ? "O" : "X",
    status,
    winner,
    moveCount
  });
}
