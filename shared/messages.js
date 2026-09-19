// Shared constants. Loaded as a classic script in content scripts and the side
// panel, and as a side-effect import in the service worker — so no top-level
// const/let (re-injection into the same isolated world would throw).
globalThis.SM = Object.freeze({
  MSG: Object.freeze({
    OP: 'sm:op',                 // any context -> background: state mutation
    SET_ACTIVE: 'sm:set-active', // background -> content: { active: boolean }
    PING: 'sm:ping',             // side panel -> background over port: keep-alive
  }),
  PORT_PREFIX: 'sm-panel:',      // side panel port name: `sm-panel:<windowId>`
  STORAGE_KEY: 'skillMaker',
  ROOT_ID: 'root',
});
