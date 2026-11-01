// Semantic retrieval needs a real embedding model. Meta has no documented embeddings
// endpoint here, so this adapter talks to a local Ollama-compatible service. The class
// is the one documented real adapter; tests inject their own object with the same shape.
const MAX_BATCH = 32;

export function validVector(vector, dimensions) {
  if (!Array.isArray(vector) && !(vector instanceof Float32Array)) return false;
  if (!vector.length || (dimensions !== undefined && vector.length !== dimensions)) return false;
  let magnitude = 0;
  for (const value of vector) { if (!Number.isFinite(value)) return false; magnitude += value * value; }
  return magnitude > 0;
}
export const encodeVector = vector => Buffer.from(Float32Array.from(vector).buffer);
export const decodeVector = blob => new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
export function cosine(a, b) {
  let dot = 0, left = 0, right = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; left += a[i] * a[i]; right += b[i] * b[i]; }
  return dot / Math.sqrt(left * right);
}

export class OllamaEmbedder {
  #fetch;
  #identity = null;
  constructor({ baseUrl = 'http://127.0.0.1:11434', model = 'nomic-embed-text', fetchImpl = fetch, queryTimeoutMs = 1500, batchTimeoutMs = 30_000 } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/u, ''); this.model = model; this.#fetch = fetchImpl;
    this.queryTimeoutMs = queryTimeoutMs; this.batchTimeoutMs = batchTimeoutMs; this.provider = 'ollama';
  }
  /** Model identity includes the served digest, so upgraded weights never compare with old vectors. */
  async identify({ signal } = {}) {
    if (this.#identity) return this.#identity;
    const response = await this.#fetch(`${this.baseUrl}/api/tags`, { signal: signal ?? AbortSignal.timeout(this.queryTimeoutMs), redirect: 'error' });
    if (!response.ok) throw new Error(`Embedding service returned HTTP ${response.status}.`);
    const { models } = await response.json();
    const match = (models ?? []).find(item => item.name === this.model || item.name === `${this.model}:latest` || item.model === this.model);
    if (!match) throw new Error(`Embedding model ${this.model} is not installed on the service.`);
    this.#identity = `ollama:${match.name}@${match.digest ?? 'unknown'}`;
    return this.#identity;
  }
  async embed(texts, { signal, kind = 'document' } = {}) {
    const model = await this.identify({ signal });
    const output = [];
    for (let i = 0; i < texts.length; i += MAX_BATCH) {
      const timeout = AbortSignal.timeout(kind === 'query' ? this.queryTimeoutMs : this.batchTimeoutMs);
      const response = await this.#fetch(`${this.baseUrl}/api/embed`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ model: this.model, input: texts.slice(i, i + MAX_BATCH) }),
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      });
      if (!response.ok) throw new Error(`Embedding service returned HTTP ${response.status}.`);
      output.push(...((await response.json()).embeddings ?? []));
    }
    return { model, vectors: output };
  }
}

/** The embedding seam used by retrieval and indexing. Failures become reported degradation, never fake vectors. */
export class EmbeddingGate {
  #embedder;
  #state = { ready: false, checked_at: null, error: 'Not checked yet.', dimensions: null, model: null };
  constructor(embedder) { this.#embedder = embedder ?? null; }
  get configured() { return Boolean(this.#embedder); }
  status() {
    return { provider: this.#embedder?.provider ?? 'none', configured_model: this.#embedder?.model ?? null, ...this.#state };
  }
  async #run(texts, options) {
    if (!this.#embedder) throw new Error('No embedding service is configured.');
    const { model, vectors } = await this.#embedder.embed(texts, options);
    if (typeof model !== 'string' || !model) throw new Error('Embedding service returned no model identity.');
    if (!Array.isArray(vectors) || vectors.length !== texts.length) throw new Error('Embedding service returned the wrong number of vectors.');
    const dimensions = vectors[0]?.length;
    if (!vectors.every(vector => validVector(vector, dimensions))) throw new Error('Embedding service returned an invalid vector.');
    this.#state = { ready: true, checked_at: new Date().toISOString(), error: null, dimensions, model };
    return { model, vectors, dimensions };
  }
  async embedQuery(text, { signal } = {}) {
    try { return await this.#run([text], { signal, kind: 'query' }); }
    catch (error) { this.#fail(error); return null; }
  }
  async embedDocuments(texts) {
    try { return await this.#run(texts, { kind: 'document' }); }
    catch (error) { this.#fail(error); throw error; }
  }
  async check() {
    await this.embedQuery('readiness check');
    return this.status();
  }
  #fail(error) {
    // Messages come from this module or fetch. Household text never appears in them.
    this.#state = { ...this.#state, ready: false, checked_at: new Date().toISOString(), error: error.name === 'TimeoutError' ? 'Embedding service timed out.' : `Embedding service unavailable: ${String(error.message).slice(0, 160)}` };
  }
}
