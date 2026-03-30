import React, { useState, useCallback, useEffect, useRef } from 'react';
import { useAppState, useAppDispatch } from '../App';
import { useFileTree } from '../hooks/useFileTree';
import { useIpcInvoke } from '../hooks/useIpc';
import type { FileTreeEntry } from '../../ipc-types';

interface ContextMenuState {
  x: number;
  y: number;
  entry: FileTreeEntry;
}

export function Explorer() {
  const state = useAppState();
  const dispatch = useAppDispatch();
  const invoke = useIpcInvoke();
  const { tree, loading } = useFileTree(state.testsDir);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);

  const toggleExpand = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  }, []);

  const handleFileClick = useCallback(
    async (entry: FileTreeEntry) => {
      if (entry.type === 'directory') {
        toggleExpand(entry.path);
        return;
      }
      // Only open .md files in the editor
      if (!entry.name.endsWith('.md')) return;

      try {
        const result = await invoke('file:read', { path: entry.path });
        dispatch({
          type: 'OPEN_FILE',
          filePath: entry.path,
          fileName: entry.name,
          content: result.content,
        });
      } catch (err) {
        console.error('Failed to read file:', err);
      }
    },
    [dispatch, invoke, toggleExpand],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, entry: FileTreeEntry) => {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY, entry });
    },
    [],
  );

  // Close context menu when clicking elsewhere
  useEffect(() => {
    if (!contextMenu) return;
    const handler = () => setContextMenu(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [contextMenu]);

  const handleNewFile = useCallback(async () => {
    if (!contextMenu) return;
    const dir =
      contextMenu.entry.type === 'directory'
        ? contextMenu.entry.path
        : contextMenu.entry.path.replace(/\/[^/]+$/, '');
    const name = prompt('New file name:');
    if (!name) return;
    const path = `${dir}/${name}`;
    try {
      await invoke('file:create', { path });
    } catch (err) {
      console.error('Failed to create file:', err);
    }
    setContextMenu(null);
  }, [contextMenu, invoke]);

  const handleRename = useCallback(async () => {
    if (!contextMenu) return;
    const newName = prompt('New name:', contextMenu.entry.name);
    if (!newName || newName === contextMenu.entry.name) return;
    const dir = contextMenu.entry.path.replace(/\/[^/]+$/, '');
    try {
      await invoke('file:rename', { from: contextMenu.entry.path, to: `${dir}/${newName}` });
    } catch (err) {
      console.error('Failed to rename:', err);
    }
    setContextMenu(null);
  }, [contextMenu, invoke]);

  const handleDelete = useCallback(async () => {
    if (!contextMenu) return;
    if (!confirm(`Delete ${contextMenu.entry.name}?`)) return;
    try {
      await invoke('file:delete', { path: contextMenu.entry.path });
    } catch (err) {
      console.error('Failed to delete:', err);
    }
    setContextMenu(null);
  }, [contextMenu, invoke]);

  const handleSelectFolder = useCallback(async () => {
    try {
      const result = await invoke('dialog:select-folder', {});
      if (result.path) {
        await invoke('set-tests-dir', { dir: result.path });
        dispatch({ type: 'SET_TESTS_DIR', dir: result.path });
      }
    } catch (err) {
      console.error('Failed to select folder:', err);
    }
  }, [dispatch, invoke]);

  const renderEntry = (entry: FileTreeEntry, depth: number) => {
    const isDir = entry.type === 'directory';
    const isExpanded = expanded.has(entry.path);
    const isRunning = state.runningFile === entry.path;
    const isActive =
      state.tabs[state.activeTabIndex]?.filePath === entry.path;

    return (
      <React.Fragment key={entry.path}>
        <div
          className={`tree-item ${isActive ? 'tree-item--active' : ''} ${isRunning ? 'tree-item--running' : ''}`}
          style={{ '--depth': depth } as React.CSSProperties}
          onClick={() => handleFileClick(entry)}
          onContextMenu={(e) => handleContextMenu(e, entry)}
        >
          {isDir && (
            <span className="tree-arrow">{isExpanded ? '\u25BE' : '\u25B8'}</span>
          )}
          {!isDir && <span className="tree-arrow" />}
          <span className="tree-icon">{isDir ? '\uD83D\uDCC1' : '\uD83D\uDCC4'}</span>
          {entry.name}
        </div>
        {isDir && isExpanded && entry.children?.map((child) => renderEntry(child, depth + 1))}
      </React.Fragment>
    );
  };

  return (
    <div className="explorer">
      <div className="explorer-header">
        <span>Explorer</span>
        <button
          className="explorer-header-btn"
          onClick={handleSelectFolder}
          title="Open folder"
        >
          &#128193;
        </button>
      </div>
      <div className="explorer-tree">
        {loading && <div className="tree-item" style={{ color: 'var(--text-secondary)' }}>Loading...</div>}
        {!loading && tree.length === 0 && (
          <div className="tree-item" style={{ color: 'var(--text-secondary)' }}>No files found</div>
        )}
        {tree.map((entry) => renderEntry(entry, 0))}
      </div>
      {contextMenu && (
        <div className="context-menu" style={{ left: contextMenu.x, top: contextMenu.y }}>
          <div className="context-menu-item" onClick={handleNewFile}>
            New File
          </div>
          <div className="context-menu-item" onClick={handleRename}>
            Rename
          </div>
          <div className="context-menu-item" onClick={handleDelete}>
            Delete
          </div>
        </div>
      )}
    </div>
  );
}
