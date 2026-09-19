// Minimal in-memory chrome.storage.local, enough for background/store.js.
// Values are structured-cloned on the way in and out, like the real API.
export function installFakeChrome() {
  const db = {};
  globalThis.chrome = {
    storage: {
      local: {
        get: async (key) => ({ [key]: db[key] === undefined ? undefined : structuredClone(db[key]) }),
        set: async (items) => Object.assign(db, structuredClone(items)),
      },
    },
  };
  return {
    reset: () => Object.keys(db).forEach((k) => delete db[k]),
  };
}
