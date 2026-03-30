/**
 * Electron main process entry point for the Runner UI.
 *
 * Accepts `testsDir` and `configPath` as command-line arguments (passed from
 * the CLI `ui` command) and creates the application window.
 *
 * Compiled as CommonJS (.cts) so that require('electron') is intercepted by
 * Electron's patched module loader rather than resolving to the npm shim.
 */

import 'dotenv/config';
import path from 'node:path';
import { watch, type FSWatcher } from 'node:fs';

import { app, BrowserWindow } from 'electron';

import { registerIpcHandlers, removeIpcHandlers, sendToRenderer } from './ipc-handler.cjs';

// ---------------------------------------------------------------------------
// Parse arguments passed from the CLI command
// ---------------------------------------------------------------------------
// electron . -- --testsDir /path --configPath /path
function parseArgs(): { testsDir: string; configPath?: string } {
  const args = process.argv;

  let testsDir = path.resolve(process.cwd(), 'tests');
  let configPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const next = args[i + 1];
    if (args[i] === '--testsDir' && next) {
      testsDir = path.resolve(next);
    }
    if (args[i] === '--configPath' && next) {
      configPath = path.resolve(next);
    }
  }

  return { testsDir, ...(configPath !== undefined && { configPath }) };
}

const { testsDir, configPath: _configPath } = parseArgs();

// ---------------------------------------------------------------------------
// Window creation
// ---------------------------------------------------------------------------
let mainWindow: BrowserWindow | null = null;
let fileWatcher: FSWatcher | null = null;

function createWindow(): void {
  const preloadPath = path.join(__dirname, '..', 'preload.cjs');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'ai-ui-auto Runner',
    webPreferences: {
      preload: preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Load from Vite dev server in development, or from built files in production
  const devServerUrl = process.env['VITE_DEV_SERVER_URL'];

  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
    mainWindow.webContents.openDevTools({ mode: 'bottom' });
  } else {
    // Production — load the built renderer from dist-ui
    const rendererPath = path.join(__dirname, '..', '..', '..', 'dist-ui', 'renderer', 'index.html');
    void mainWindow.loadFile(rendererPath);
  }

  // Register IPC handlers once the window exists
  void registerIpcHandlers({ mainWindow, testsDir });

  // Start watching the tests directory for external file changes
  startFileWatcher(mainWindow, testsDir);

  mainWindow.on('closed', () => {
    stopFileWatcher();
    removeIpcHandlers();
    mainWindow = null;
  });
}

// ---------------------------------------------------------------------------
// File watcher
// ---------------------------------------------------------------------------
function startFileWatcher(window: BrowserWindow, dir: string): void {
  try {
    fileWatcher = watch(dir, { recursive: true }, (eventType, filename) => {
      if (!filename || eventType !== 'change') return;

      const fullPath = path.join(dir, filename);

      // Notify renderer that the file changed
      sendToRenderer(window, 'file:changed', { path: fullPath });
    });
  } catch {
    // fs.watch may not be supported on all platforms with recursive option
    console.warn('Could not start file watcher for', dir);
  }
}

function stopFileWatcher(): void {
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
}

// ---------------------------------------------------------------------------
// App lifecycle
// ---------------------------------------------------------------------------
void app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    // macOS: re-create window when dock icon is clicked and no windows are open
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  // On macOS, apps typically stay active until the user explicitly quits
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  stopFileWatcher();
  removeIpcHandlers();
});
