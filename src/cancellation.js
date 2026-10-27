import { AppError } from './errors.js';

export function checkCancelled(signal) {
  if (signal?.aborted) throw new AppError('That request was interrupted. Completed actions are still shown.', 499);
}
