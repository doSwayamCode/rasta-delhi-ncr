export const THEME_KEY = "rasta-theme";

/**
 * Runs in <head> before first paint so the page never flashes the wrong theme.
 * Kept as a string because it must not wait for the React bundle.
 */
export const THEME_BOOT_SCRIPT = `(function(){try{var m=localStorage.getItem("${THEME_KEY}");
if(m!=="light"&&m!=="dark")m=matchMedia("(prefers-color-scheme: light)").matches?"light":"dark";
document.documentElement.dataset.theme=m}catch(e){document.documentElement.dataset.theme="dark"}})();`;
