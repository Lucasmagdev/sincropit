import { app, BrowserWindow, ipcMain, dialog, Menu, screen } from "electron";
import { fileURLToPath } from "node:url";
import path from "node:path";
import fs from "node:fs";
import { generateFakePte } from "./fakePte";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const VITE_DEV_SERVER_URL = process.env.VITE_DEV_SERVER_URL;

if (Menu) {
  Menu.setApplicationMenu(null);
}

function createWindow() {
  // O app roda no PRÓPRIO PIT-Q, que é um PC industrial de tela pequena
  // (painéis assim costumam ser 800x600 ou 1024x768). Com tamanhos fixos
  // (1360x880, mínimo 960x640) a janela ficava maior que a tela e, pior, o
  // mínimo de 640px de altura impedia encolher pra caber num monitor de
  // 600px — parte da interface (inclusive os botões de exportar, no fim da
  // barra lateral) ficava fora da tela e inalcançável. Aqui a janela se
  // ajusta à área útil real do monitor.
  const area = screen.getPrimaryDisplay().workAreaSize;
  const largura = Math.min(1360, area.width);
  const altura = Math.min(880, area.height);

  const win = new BrowserWindow({
    width: largura,
    height: altura,
    minWidth: Math.min(820, area.width),
    minHeight: Math.min(560, area.height),
    backgroundColor: "#0b0d0c",
    autoHideMenuBar: true,
    icon: path.join(__dirname, "../build/icon.ico"),
    webPreferences: {
      preload: path.join(__dirname, "preload.mjs"),
    },
  });

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL);
  } else {
    win.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

ipcMain.handle("pte:export-pdf", async (event, suggestedName: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const result = await dialog.showSaveDialog(win, {
    defaultPath: suggestedName,
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (result.canceled || !result.filePath) return null;
  const pdfBuffer = await win.webContents.printToPDF({
    landscape: true,
    printBackground: true,
    pageSize: "A4",
  });
  fs.writeFileSync(result.filePath, pdfBuffer);
  return result.filePath;
});

ipcMain.handle("pte:export-csv", async (event, suggestedName: string, csvContent: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const result = await dialog.showSaveDialog(win, {
    defaultPath: suggestedName,
    filters: [{ name: "CSV", extensions: ["csv"] }],
  });
  if (result.canceled || !result.filePath) return null;
  fs.writeFileSync(result.filePath, csvContent, "utf-8");
  return result.filePath;
});

function readPteFile(filePath: string) {
  const data = fs.readFileSync(filePath);
  return { filePath, name: path.basename(filePath), buffer: data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) };
}

let watcher: fs.FSWatcher | null = null;
let watchDebounce: NodeJS.Timeout | null = null;
const lastSentSize = new Map<string, number>();

function stopWatching() {
  if (watchDebounce) {
    clearTimeout(watchDebounce);
    watchDebounce = null;
  }
  if (watcher) {
    watcher.close();
    watcher = null;
  }
  lastSentSize.clear();
}

ipcMain.handle("pte:pick-folder", async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, { properties: ["openDirectory"] });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle("pte:watch-start", async (event, folderPath: string) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  stopWatching();
  // a janela pode ter sido fechada durante o debounce de 600ms — mandar pra
  // um webContents destruido lanca excecao no processo main.
  const enviar = (canal: string, dados?: unknown) => {
    if (win && !win.isDestroyed()) win.webContents.send(canal, dados);
  };

  try {
    watcher = fs.watch(folderPath, { persistent: true }, (_eventType, filename) => {
      if (!filename || !/\.pte$/i.test(filename)) return;
      const fullPath = path.join(folderPath, filename);
      if (watchDebounce) clearTimeout(watchDebounce);
      // debounce: o PIT-Q escreve o arquivo em varias etapas — espera
      // parar de mudar antes de ler, senao pega arquivo pela metade.
      watchDebounce = setTimeout(() => {
        try {
          const stat = fs.statSync(fullPath);
          if (!stat.isFile()) return;
          // so notifica se o tamanho parou de crescer desde a ultima checagem
          const prevSize = lastSentSize.get(fullPath);
          if (prevSize === stat.size) return;
          lastSentSize.set(fullPath, stat.size);
          const fileData = readPteFile(fullPath);
          enviar("pte:file-changed", fileData);
        } catch {
          // arquivo pode ter sido apagado/renomeado entre o evento e a leitura
        }
      }, 600);
    });

    // SEM ISTO O APP MORRE: fs.watch emite 'error' quando a pasta some
    // (pendrive removido, rede caiu, pasta apagada). Um 'error' sem ouvinte
    // num EventEmitter vira excecao nao capturada no processo main do
    // Electron e derruba o app inteiro. Aqui a captura vira um aviso na UI.
    watcher.on("error", (err: Error) => {
      stopWatching();
      enviar("pte:watch-error", err?.message ?? "a pasta observada ficou indisponível");
    });

    return true;
  } catch {
    return false;
  }
});

ipcMain.handle("pte:watch-stop", async () => {
  stopWatching();
  return true;
});

ipcMain.handle("pte:open-dialog", async () => {
  const result = await dialog.showOpenDialog({
    filters: [{ name: "Ensaio PIT", extensions: ["PTE", "pte"] }],
    properties: ["openFile"],
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return readPteFile(result.filePaths[0]);
});

ipcMain.handle("pte:read-path", async (_event, filePath: string) => {
  try {
    return readPteFile(filePath);
  } catch {
    return null;
  }
});

ipcMain.handle("sim:generate-signal", async () => {
  try {
    const buf = generateFakePte();
    const name = `Simulacao_${Date.now()}.PTE`;
    return { filePath: "", name, buffer: buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) };
  } catch (e) {
    console.error("Simulate signal error:", e);
    return null;
  }
});

app.whenReady().then(createWindow);

app.on("window-all-closed", () => {
  stopWatching();
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
