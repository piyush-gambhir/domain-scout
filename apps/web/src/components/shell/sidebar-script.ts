
export const SIDEBAR_STORAGE_KEY = 'ds.sidebar';


export const SIDEBAR_INIT_SCRIPT = `try{if(localStorage.getItem('${SIDEBAR_STORAGE_KEY}')==='collapsed')document.documentElement.setAttribute('data-sidebar','collapsed')}catch(e){}`;
