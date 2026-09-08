import { contextBridge, ipcRenderer } from "electron";
import type { WorkLensAPI } from "../shared/contracts";
const api: WorkLensAPI = {
  invoke: async (method, input) => {
    const result = await ipcRenderer.invoke("worklens:request", method, input);
    if (!result.ok) throw new Error(result.error);
    return result.value;
  },
  onChat: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      value: Parameters<typeof listener>[0],
    ) => listener(value);
    ipcRenderer.on("worklens:chat", handler);
    return () => ipcRenderer.removeListener("worklens:chat", handler);
  },
  onAuth: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      value: Parameters<typeof listener>[0],
    ) => listener(value);
    ipcRenderer.on("worklens:auth", handler);
    return () => ipcRenderer.removeListener("worklens:auth", handler);
  },
};
contextBridge.exposeInMainWorld("worklens", api);
