import { AppError } from './errors.js';

export class MetaClient {
  constructor({ apiKey = '', model = 'muse-spark-1.3', fetchImpl = fetch } = {}) {
    if (!/^muse-(spark-1\.[123]|wonder-1\.0)$/.test(model)) {
      throw new AppError('Use a supported standard Meta text model. Contributor variants are disabled.');
    }
    this.apiKey = apiKey.trim();
    this.model = model;
    this.fetch = fetchImpl;
  }

  get configured() { return Boolean(this.apiKey); }

  async request(path, body) {
    if (!this.configured) throw new AppError('Add META_API_KEY to .env and restart the server to connect Meta.', 503);
    let response;
    try {
      response = await this.fetch(`https://api.meta.ai/v1/${path}`, {
        method: body ? 'POST' : 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(60_000),
        redirect: 'error',
      });
    } catch {
      throw new AppError('Meta could not be reached or timed out. Check the connection and the tool results before submitting again.', 502);
    }
    if (!response.ok) {
      const detail = response.status === 401 || response.status === 403
        ? 'Check your API key and model access.'
        : response.status === 429 ? 'Check the account quota or wait before trying again.'
          : 'Check model availability and the API request configuration.';
      // Do not send upstream error bodies to the browser: they can echo private inputs.
      throw new AppError(`Meta returned HTTP ${response.status}. ${detail}`, 502);
    }
    try { return await response.json(); }
    catch { throw new AppError('Meta returned an unreadable response.', 502); }
  }

  async respond(input, tools, instructions) {
    const response = await this.request('responses', {
      model: this.model, input, instructions, tools,
      store: false,
      include: ['reasoning.encrypted_content', 'web_search_call.results'],
      tool_choice: 'auto',
      parallel_tool_calls: false,
      max_tool_calls: 3,
      max_output_tokens: 4096,
    });
    if (response.status !== 'completed' || !Array.isArray(response.output)) {
      throw new AppError('Meta did not finish its response. No partial function calls were executed.', 502);
    }
    return response.output;
  }

  async checkAccess() {
    const result = await this.request('models');
    if (!Array.isArray(result.data) || !result.data.some(item => item.id === this.model)) {
      throw new AppError(`The account did not list ${this.model}. Check access before using this model.`, 503);
    }
    return { model: this.model, available: true };
  }
}
