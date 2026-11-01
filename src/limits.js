// Bound a compound request while leaving room for many independent tasks.
export const MAX_MODEL_ROUNDS = 8;
export const MAX_FUNCTION_CALLS = 64;
export const MAX_SEARCH_CALLS = 12;
// Extra search-only rounds allowed when a required lookup was skipped.
export const MAX_LOOKUP_ENFORCEMENTS = 2;
export const MODEL_TIMEOUT_MS = 60_000;
export const MAX_PAGE_READS = 4;
