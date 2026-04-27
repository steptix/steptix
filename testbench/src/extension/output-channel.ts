import * as vscode from 'vscode';

let channel: vscode.OutputChannel | undefined;

/**
 * The single shared "TestBench" output channel. Every error and run-log line
 * the extension emits must go here so users always have one place to look.
 */
export function getOutputChannel(): vscode.OutputChannel {
  if (!channel) channel = vscode.window.createOutputChannel('TestBench');
  return channel;
}

export function disposeOutputChannel(): void {
  channel?.dispose();
  channel = undefined;
}
