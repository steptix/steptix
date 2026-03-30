/**
 * Registers all IPC handlers for the Electron main process.
 * Bridges renderer invoke calls to file-manager and runner-adapter functions.
 */

import { ipcMain, type BrowserWindow } from 'electron';

import {
  readFile,
  writeFile,
  listDirectory,
  createFile,
  renameFile,
  deleteFile,
} from './file-manager.js';
import { UIRunnerAdapter } from './runner-adapter.js';
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
 */
export function registerIpcHandlers({ mainWindow, testsDir }: IpcHandlerOptions): void {
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
  ];

  for (const channel of channels) {
    ipcMain.removeHandler(channel);
  }
}
