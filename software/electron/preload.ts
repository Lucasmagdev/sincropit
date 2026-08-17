import { contextBridge, ipcRenderer } from "electron";

type PteFileMsg = { filePath: string; name: string; buffer: ArrayBuffer };

contextBridge.exposeInMainWorld("pit", {
  openFileDialog: (): Promise<PteFileMsg | null> => ipcRenderer.invoke("pte:open-dialog"),
  readPath: (filePath: string): Promise<PteFileMsg | null> => ipcRenderer.invoke("pte:read-path", filePath),
  exportPdf: (suggestedName: string): Promise<string | null> => ipcRenderer.invoke("pte:export-pdf", suggestedName),
  exportCsv: (suggestedName: string, csvContent: string): Promise<string | null> =>
    ipcRenderer.invoke("pte:export-csv", suggestedName, csvContent),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke("pte:pick-folder"),
  watchFolder: (folderPath: string): Promise<boolean> => ipcRenderer.invoke("pte:watch-start", folderPath),
  stopWatch: (): Promise<boolean> => ipcRenderer.invoke("pte:watch-stop"),
  onFileChanged: (cb: (file: PteFileMsg) => void): (() => void) => {
    const listener = (_event: unknown, data: PteFileMsg) => cb(data);
    ipcRenderer.on("pte:file-changed", listener);
    return () => ipcRenderer.removeListener("pte:file-changed", listener);
  },
  onWatchError: (cb: (msg: string) => void): (() => void) => {
    const listener = (_event: unknown, msg: string) => cb(msg);
    ipcRenderer.on("pte:watch-error", listener);
    return () => ipcRenderer.removeListener("pte:watch-error", listener);
  },
  sim: {
    generateSignal: (): Promise<PteFileMsg | null> => ipcRenderer.invoke("sim:generate-signal"),
  },
});
