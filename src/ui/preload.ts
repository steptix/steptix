/**
 * Electron preload script.
 * Exposes a typed `electronBridge` API to the renderer via contextBridge.
 */

import { contextBridge, ipcRenderer } from 'electron';

import type {
  ElectronBridgeApi,
  MainToRendererEvents,
  RendererToMainInvokes,
} from './ipc-types.js';

const bridge: ElectronBridgeApi = {
  invoke<K extends keyof RendererToMainInvokes>(
    channel: K,
    params: RendererToMainInvokes[K]['params'],
  ): Promise<RendererToMainInvokes[K]['result']> {
    return ipcRenderer.invoke(channel, params);
  },

  on<K extends keyof MainToRendererEvents>(
    channel: K,
    callback: (data: MainToRendererEvents[K]) => void,
  ): () => void {
    const listener = (_event: Electron.IpcRendererEvent, data: MainToRendererEvents[K]) => {
      callback(data);
    };

    ipcRenderer.on(channel, listener);

    // Return an unsubscribe function
    return () => {
      ipcRenderer.removeListener(channel, listener);
    };
  },

  getInitialData(): Promise<{ testsDir: string }> {
    return ipcRenderer.invoke('get-initial-data');
  },
};

contextBridge.exposeInMainWorld('electronBridge', bridge);
