// Types for ratingCode.generated.js - the slice of src/lib/battleRatingBoards.ts the function calls.
// Hand-written and deliberately loose: the rows come straight out of json_agg, and the real types live
// with the source. If an export the function uses changes shape, update this alongside it.

export interface BoardSource {
  match_key: string
  room_id: string | null
  board_seed: string | null
  board_perm: number[] | null
}

/** Flat and JSON-safe: every field is a string, a finite number, a boolean or null. */
export interface BattleRating {
  matchKey: string
  [field: string]: string | number | boolean | null
}

export interface BoardRatings {
  weights: Map<string, number>
  ratings: BattleRating[]
}

// deno-lint-ignore no-explicit-any
type Row = Record<string, any>

export function prepareParticipants(rows: Row[]): Row[]
export function prepareEvents(rows: Row[], sources: Map<string, BoardSource>): Row[]
export function rateEveryBoard(parts: Row[], events: Row[]): Map<string, BoardRatings>
export const RATING_CODE_VERSION: string
