const { contextBridge } = require('electron');

// main.cjs passes the port the in-process proxy actually bound to through
// webPreferences.additionalArguments (--proxy-port=<port>). The renderer is the
// only consumer; nothing else is exposed on the bridge.
const portArg = process.argv.find((arg) => arg.startsWith('--proxy-port='));
const port = portArg ? Number(portArg.split('=')[1]) : NaN;
const proxyBaseUrl = Number.isInteger(port) && port > 0 ? `http://127.0.0.1:${port}` : undefined;

contextBridge.exposeInMainWorld('leadershipPanel', { proxyBaseUrl });
