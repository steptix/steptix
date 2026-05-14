// Flick settings are stored as VS Code configuration (`flick.*`) rather than a
// standalone settings.json file — this is the idiomatic equivalent for an
// extension and lets users edit them through the normal Settings UI too.

import * as vscode from 'vscode';
import type { FlickSettings } from '../shared/protocol';

const SECTION = 'flick';

export function readSettings(): FlickSettings {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  return {
    apiUrl: (cfg.get<string>('apiUrl') ?? 'http://127.0.0.1:3100').trim(),
    apiKey: cfg.get<string>('apiKey') ?? '',
    defaultBaseUrl: (cfg.get<string>('defaultBaseUrl') ?? '').trim(),
    defaultTimeout: (cfg.get<string>('defaultTimeout') ?? '').trim(),
  };
}

export async function writeSettings(settings: FlickSettings): Promise<void> {
  const cfg = vscode.workspace.getConfiguration(SECTION);
  const target = vscode.ConfigurationTarget.Global;
  await cfg.update('apiUrl', settings.apiUrl.trim(), target);
  await cfg.update('apiKey', settings.apiKey, target);
  await cfg.update('defaultBaseUrl', settings.defaultBaseUrl.trim(), target);
  await cfg.update('defaultTimeout', settings.defaultTimeout.trim(), target);
}

/** True when the changed configuration affects any `flick.*` key. */
export function affectsFlick(e: vscode.ConfigurationChangeEvent): boolean {
  return e.affectsConfiguration(SECTION);
}
