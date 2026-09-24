const { contextBridge, ipcRenderer } = require("electron");

ipcRenderer.on("real-client:bridge-restored", () => {
  window.dispatchEvent(new Event("wechatvibe-service-restored"));
});

const DOC_URLS = new Set([
  "https://www.myersbriggs.org/my-mbti-personality-type/the-mbti-preferences/",
  "https://www.themyersbriggs.com/en-US/Products-and-Services/Myers-Briggs",
  "https://github.com/tswawa",
  "https://github.com/tswawa/WechatVibe",
]);

document.addEventListener("click", (event) => {
  if (!event.isTrusted || event.button !== 0 || !navigator.userActivation.isActive || window.top !== window) return;
  const anchor = event.target instanceof Element ? event.target.closest("a[href]") : null;
  if (!anchor) return;
  let target;
  try {
    target = new URL(anchor.href);
  } catch (_) {
    return;
  }
  if (!DOC_URLS.has(target.href) || target.username || target.password) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  ipcRenderer.send("real-client:open-doc", target.href, true, true);
}, true);

contextBridge.exposeInMainWorld("desktopHost", Object.freeze({
  platform: "win32",
  setTheme(theme) {
    if (theme !== "dark" && theme !== "light") return false;
    ipcRenderer.send("real-client:set-theme", theme);
    return true;
  },
  copyDraft(value) {
    if (typeof value !== "string" || !value.trim() || value.length > 1_000_000 ||
        !navigator.userActivation.isActive || window.top !== window) return Promise.resolve(false);
    return ipcRenderer.invoke("real-client:copy-draft", value);
  },
  exitApp() {
    if (window.top !== window) return Promise.resolve(false);
    return ipcRenderer.invoke("real-client:exit-app");
  },
}));
