/**
 * Registers all IPC handlers for the Electron main process.
 * Bridges renderer invoke calls to file-manager and runner-adapter functions.
 *
 * Compiled as CommonJS (.cts) so that require('electron') is intercepted by
 * Electron's patched module loader. ESM dependencies are loaded via dynamic
 * import() which CJS supports.
 */

import { ipcMain, dialog } from 'electron';
import type { BrowserWindow } from 'electron';
import type { UIRunnerAdapter } from './runner-adapter.js';
import type { MainToRendererEvents } from '../ipc-types.js';

interface IpcHandlerOptions {
  /** The main BrowserWindow instance for sending events to the renderer. */
  mainWindow: BrowserWindow;
  /** The root tests directory — used for path validation and default listings. */
  testsDir: string;
}

/**
 * Send a typed event from the main process to the renderer.
 */
export function sendToRenderer<K extends keyof MainToRendererEvents>(
  mainWindow: BrowserWindow,
  channel: K,
  data: MainToRendererEvents[K],
): void {
  if (!mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, data);
  }
}

/** Singleton runner adapter — created on first use. */
let runnerAdapter: UIRunnerAdapter | null = null;

/**
 * Register all IPC handlers. Should be called once during app initialisation.
 * Returns a promise that resolves once all ESM dependencies are loaded.
 */
export async function registerIpcHandlers({ mainWindow, testsDir: initialTestsDir }: IpcHandlerOptions): Promise<void> {
  // Load ESM modules dynamically (CJS cannot statically require ESM in all environments)
  const [runnerMod, fileMod] = await Promise.all([
    import('./runner-adapter.js') as Promise<typeof import('./runner-adapter.js')>,
    import('./file-manager.js') as Promise<typeof import('./file-manager.js')>,
  ]);

  const { UIRunnerAdapter } = runnerMod;
  const { readFile, writeFile, listDirectory, createFile, renameFile, deleteFile } = fileMod;

  // Mutable so the user can change it via the folder picker
  let testsDir = initialTestsDir;

  // Create the runner adapter with an emit function that sends to the renderer
  runnerAdapter = new UIRunnerAdapter((channel, data) => {
    sendToRenderer(mainWindow, channel, data);
  });

  // -------------------------------------------------------------------------
  // Initial data
  // -------------------------------------------------------------------------
  ipcMain.handle('get-initial-data', () => {
    return { testsDir };
  });

  // -------------------------------------------------------------------------
  // File operations
  // -------------------------------------------------------------------------
  ipcMain.handle('file:read', (_event, params: { path: string }) => {
    return readFile(params.path, testsDir);
  });

  ipcMain.handle(
    'file:write',
    (_event, params: { path: string; content: string }) => {
      return writeFile(params.path, params.content, testsDir);
    },
  );

  ipcMain.handle('file:list', (_event, params: { dir: string }) => {
    return listDirectory(params.dir, testsDir);
  });

  ipcMain.handle('file:create', (_event, params: { path: string }) => {
    return createFile(params.path, testsDir);
  });

  ipcMain.handle(
    'file:rename',
    (_event, params: { from: string; to: string }) => {
      return renameFile(params.from, params.to, testsDir);
    },
  );

  ipcMain.handle('file:delete', (_event, params: { path: string }) => {
    return deleteFile(params.path, testsDir);
  });

  // -------------------------------------------------------------------------
  // Runner operations
  // -------------------------------------------------------------------------
  ipcMain.handle(
    'runner:start',
    (_event, params: { filePath: string; breakpoints: number[] }) => {
      // Fire-and-forget — the adapter emits events as the run progresses
      void runnerAdapter!.start(params.filePath, params.breakpoints);
    },
  );

  ipcMain.handle('runner:stop', () => {
    runnerAdapter!.stop();
  });

  ipcMain.handle('runner:resume', () => {
    runnerAdapter!.resume();
  });

  ipcMain.handle('runner:step-over', () => {
    runnerAdapter!.stepOver();
  });

  ipcMain.handle(
    'runner:move-pointer',
    (_event, params: { toStepIndex: number }) => {
      runnerAdapter!.movePointer(params.toStepIndex);
    },
  );

  ipcMain.handle(
    'runner:steer',
    async (_event, params: { instruction: string }) => {
      await runnerAdapter!.steer(params.instruction);
    },
  );

  ipcMain.handle(
    'runner:input-response',
    (_event, params: { variable: string; value: string }) => {
      runnerAdapter!.inputResponse(params.variable, params.value);
    },
  );

  ipcMain.handle(
    'runner:update-breakpoints',
    (_event, params: { breakpoints: number[] }) => {
      runnerAdapter!.updateBreakpoints(params.breakpoints);
    },
  );

  // -------------------------------------------------------------------------
  // Folder picker
  // -------------------------------------------------------------------------
  ipcMain.handle('dialog:select-folder', async () => {
    const result = await dialog.showOpenDialog(mainWindow, {
      properties: ['openDirectory'],
      defaultPath: testsDir,
      title: 'Select tests folder',
    });
    return { path: result.canceled ? null : (result.filePaths[0] ?? null) };
  });

  ipcMain.handle('set-tests-dir', (_event, params: { dir: string }) => {
    testsDir = params.dir;
  });
}

/**
 * Remove all registered IPC handlers. Call on app quit for clean teardown.
 */
export function removeIpcHandlers(): void {
  const channels = [
    'get-initial-data',
    'file:read',
    'file:write',
    'file:list',
    'file:create',
    'file:rename',
    'file:delete',
    'runner:start',
    'runner:stop',
    'runner:resume',
    'runner:step-over',
    'runner:move-pointer',
    'runner:steer',
    'runner:input-response',
    'runner:update-breakpoints',
    'dialog:select-folder',
    'set-tests-dir',
  ];

  for (const channel of channels) {
    ipcMain.removeHandler(channel);
  }
}
