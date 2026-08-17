export {};

type PteFileMsg = { filePath: string; name: string; buffer: ArrayBuffer };

declare global {
  interface Window {
    pit?: {
      openFileDialog: () => Promise<PteFileMsg | null>;
      readPath: (filePath: string) => Promise<PteFileMsg | null>;
      exportPdf: (suggestedName: string) => Promise<string | null>;
      exportCsv: (suggestedName: string, csvContent: string) => Promise<string | null>;
      pickFolder: () => Promise<string | null>;
      watchFolder: (folderPath: string) => Promise<boolean>;
      stopWatch: () => Promise<boolean>;
      onFileChanged: (cb: (file: PteFileMsg) => void) => () => void;
      onWatchError: (cb: (msg: string) => void) => () => void;
      sim: {
        generateSignal: () => Promise<PteFileMsg | null>;
      };
    };
  }
}
