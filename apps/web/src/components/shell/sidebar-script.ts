/* Shared by the server layout and the client store; must not be a client module. */
export const SIDEBAR_STORAGE_KEY = 'ds.sidebar';

/** Runs before first paint so a collapsed sidebar never flashes open. Must stay tiny and never throw. */
export const SIDEBAR_INIT_SCRIPT = `try{if(localStorage.getItem('${SIDEBAR_STORAGE_KEY}')==='collapsed')document.documentElement.setAttribute('data-sidebar','collapsed')}catch(e){}`;
