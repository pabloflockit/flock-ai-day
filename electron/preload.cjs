const { contextBridge, ipcRenderer } = require('electron');

// main.cjs passes the port and the per-launch session secret the in-process proxy uses through
// webPreferences.additionalArguments. This is the ONLY surface exposed to the renderer; every
// function below is validated again in the main process (bridge-validation.cjs).
const readArg = (name) => {
  const prefix = `--${name}=`;
  const arg = process.argv.find((value) => value.startsWith(prefix));
  return arg ? arg.slice(prefix.length) : undefined;
};

const port = Number(readArg('proxy-port'));
const proxyBaseUrl = Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : undefined;
const proxySecret = readArg('proxy-secret');

contextBridge.exposeInMainWorld('leadershipPanel', {
  proxyBaseUrl,
  proxySecret,
  openInJira: (issueKey) => ipcRenderer.invoke('bridge:openInJira', issueKey),
  copyText: (text) => ipcRenderer.invoke('bridge:copyText', text),
  saveMarkdown: (suggestedName, content) =>
    ipcRenderer.invoke('bridge:saveMarkdown', suggestedName, content),
  saveHtml: (suggestedName, content) =>
    ipcRenderer.invoke('bridge:saveHtml', suggestedName, content),
});
