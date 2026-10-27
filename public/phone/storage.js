const DB_NAME = 'merlin-phone-attachments-v1';
let database;
export const MAX_FILE_SIZE = 10 * 1024 * 1024;
export const MAX_TOTAL_SIZE = 50 * 1024 * 1024;
async function openDB() {
  if (!globalThis.indexedDB) throw new Error('Local file storage is unavailable in this browser.');
  if (!database) database = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('files');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => { database = null; reject(new Error('Local file storage could not open.')); };
    request.onblocked = () => { database = null; reject(new Error('Close other MERLIN demo tabs and try again.')); };
  });
  return database;
}
async function transaction(mode, operation) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('files', mode);
    let value;
    const request = operation(tx.objectStore('files'));
    if (request) request.onsuccess = () => { value = request.result; };
    tx.oncomplete = () => resolve(value);
    tx.onerror = tx.onabort = () => reject(new Error('The file could not be saved. Free some browser storage and try again.'));
  });
}
export const saveFile = (id, file) => transaction('readwrite', store => store.put(file, id));
export const readFile = id => transaction('readonly', store => store.get(id));
export const deleteFile = id => transaction('readwrite', store => store.delete(id));
export const clearFiles = () => transaction('readwrite', store => store.clear());
export async function pruneFiles(keepIds) {
  const keys = await transaction('readonly', store => store.getAllKeys());
  await Promise.all(keys.filter(key => !keepIds.has(key)).map(deleteFile));
}
