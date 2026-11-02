// Bound a compound request while leaving room for many independent tasks.
export const MAX_MODEL_ROUNDS = 8;
export const MAX_FUNCTION_CALLS = 64;
export const MAX_SEARCH_CALLS = 12;
// Extra search-only rounds allowed when a required lookup was skipped.
export const MAX_LOOKUP_ENFORCEMENTS = 2;
export const MODEL_TIMEOUT_MS = 60_000;
export const MAX_PAGE_READS = 4;
// A yes to the camera question must come soon after it; the capture wait covers a browser permission prompt.
export const CAMERA_CONSENT_MS = 120_000;
export const CAMERA_CAPTURE_MS = 45_000;
export const MAX_CAMERA_FRAME_BYTES = 3 * 1024 * 1024;
export const MAX_CAMERA_CONCEPTS = 4;
