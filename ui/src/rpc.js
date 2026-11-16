const tauriGlobal = window.__TAURI__ || {};
export const inv = (tauriGlobal.core && tauriGlobal.core.invoke)
  || (async () => { throw new Error('window.__TAURI__.core.invoke indisponível'); });
export const listen = (tauriGlobal.event && tauriGlobal.event.listen)
  || (async () => () => {});
export const PREFIX = 'PI_SUBAGENT_ASYNC_JSON:';
