import { useState, useEffect, useCallback } from 'react';
import { useIpcEvent } from './useIpc';
import type { FileTreeEntry } from '../../ipc-types';

interface UseFileTreeReturn {
  tree: FileTreeEntry[];
  refresh: () => void;
  loading: boolean;
}

/**
 * Hook that fetches and manages the file tree for the explorer panel.
 */
export function useFileTree(testsDir: string): UseFileTreeReturn {
  const [tree, setTree] = useState<FileTreeEntry[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(() => {
    if (!testsDir || !window.electronBridge) return;
    setLoading(true);
    window.electronBridge
      .invoke('file:list', { dir: testsDir })
      .then((result) => {
        setTree(result.tree);
      })
      .catch((err) => {
        console.error('Failed to load file tree:', err);
      })
      .finally(() => {
        setLoading(false);
      });
  }, [testsDir]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Refresh when files change externally
  useIpcEvent('file:changed', () => {
    refresh();
  });

  return { tree, refresh, loading };
}
