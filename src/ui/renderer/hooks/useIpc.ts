import { useEffect, useCallback, useRef } from 'react';
import type { MainToRendererEvents, RendererToMainInvokes } from '../../ipc-types';

/**
 * Subscribe to a main-to-renderer IPC event. Automatically cleans up on unmount.
 */
export function useIpcEvent<K extends keyof MainToRendererEvents>(
  channel: K,
  callback: (data: MainToRendererEvents[K]) => void,
): void {
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    const bridge = window.electronBridge;
    if (!bridge) return;

    const unsub = bridge.on(channel, (data) => {
      callbackRef.current(data);
    });

    return unsub;
  }, [channel]);
}

/**
 * Returns a typed invoke function for sending requests to the main process.
 */
export function useIpcInvoke() {
  const invoke = useCallback(
    <K extends keyof RendererToMainInvokes>(
      channel: K,
      params: RendererToMainInvokes[K]['params'],
    ): Promise<RendererToMainInvokes[K]['result']> => {
      const bridge = window.electronBridge;
      if (!bridge) {
        return Promise.reject(new Error('electronBridge not available'));
      }
      return bridge.invoke(channel, params);
    },
    [],
  );

  return invoke;
}
