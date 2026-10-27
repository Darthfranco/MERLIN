export const STORAGE_KEY = 'merlin.connections.demo.v1';

export function decodeConnections(raw, allowedIds) {
  if (!raw) return new Set();
  const parsed = JSON.parse(raw);
  if (parsed?.version !== 1 || !Array.isArray(parsed.ids)) throw new Error('Unrecognized demo storage');
  const allowed = new Set(allowedIds);
  return new Set(parsed.ids.filter(id => typeof id === 'string' && allowed.has(id)));
}

export function readConnections(storage, allowedIds) {
  try {
    return { ids: decodeConnections(storage.getItem(STORAGE_KEY), allowedIds), error: null };
  } catch {
    return { ids: new Set(), error: 'Saved demo connections could not be loaded. You can start again here.' };
  }
}

export function writeConnections(storage, ids, allowedIds) {
  const allowed = new Set(allowedIds);
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, ids: [...ids].filter(id => allowed.has(id)).sort() }));
    return null;
  } catch {
    return 'Browser storage is unavailable. Your demo connections will last only for this page session.';
  }
}
