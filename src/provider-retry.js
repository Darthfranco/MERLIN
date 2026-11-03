// One more try when Meta could not be reached at all, or answered with a gateway error (seen November 3, 2026: a
// connection that never opened, failing after about ten seconds, then working on the next attempt). It is safe to
// repeat: requests are stateless, and nothing runs locally until a response arrives. Both attempts share the
// caller's signal, so cancellation and the overall timeout still end the request; neither is retried.
const RETRY_STATUS = new Set([502, 503, 504]);
export const RETRY_DELAY_MS = 400;

const pause = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) { reject(signal.reason); return; }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
});

/** Like fetch, with at most one retry. `onRetry` gets a short reason code, never request or response content. */
export async function fetchWithRetry(fetchImpl, url, init, { delayMs = RETRY_DELAY_MS, onRetry } = {}) {
  try {
    const response = await fetchImpl(url, init);
    if (!RETRY_STATUS.has(response?.status)) return response;
    await response.body?.cancel?.().catch(() => {});
    onRetry?.(`HTTP ${response.status}`);
  } catch (error) {
    if (init?.signal?.aborted) throw error;
    onRetry?.(String(error?.cause?.code ?? error?.name ?? 'network error').slice(0, 40));
  }
  await pause(delayMs, init?.signal);
  return fetchImpl(url, init);
}
