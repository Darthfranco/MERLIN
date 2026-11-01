// Scripted fetch for connector tests. Each route answers matching requests; unmatched requests fail the test.
// Mock responses prove MERLIN's request/response handling only. They are not evidence that a real service works.
export function mockFetch(routes) {
  const calls = [];
  const queue = routes.map(route => ({ ...route }));
  const fetch = async (url, options = {}) => {
    const method = options.method ?? 'GET';
    const body = options.body === undefined ? undefined : JSON.parse(options.body);
    const call = { url: String(url), method, headers: Object.fromEntries(Object.entries(options.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])), body, redirect: options.redirect };
    calls.push(call);
    const index = queue.findIndex(route => (route.method ?? 'GET') === method && (route.url instanceof RegExp ? route.url.test(call.url) : call.url === route.url || call.url.endsWith(route.url)));
    if (index < 0) throw new Error(`Unexpected request: ${method} ${call.url}`);
    const route = queue[index];
    if (!route.repeat) queue.splice(index, 1);
    if (route.throws) throw Object.assign(new Error(route.throws), { name: route.throws === 'timeout' ? 'TimeoutError' : 'TypeError' });
    route.check?.(call);
    const status = route.status ?? 200;
    const headers = { 'content-type': 'application/json', ...(route.headers ?? {}) };
    const payload = route.text !== undefined ? route.text : route.json === undefined ? '' : JSON.stringify(route.json);
    return new Response(status === 204 ? null : payload, { status, headers });
  };
  return Object.assign(fetch, { calls, pending: () => queue.filter(route => !route.repeat).length });
}

export const noSleep = () => Promise.resolve();
