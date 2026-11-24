/**
 * The agent's Allow/Deny question (docs/specs/SPEC-use-agent.md §6.3): a
 * QuickPick that stays open when focus moves (`ignoreFocusOut`), because a
 * notification can slide out of sight while the server waits on it.
 *
 * The server owns the question's life. It says when one opens
 * (`agent:awaiting-approval`) and when it closes, however it closes
 * (`agent:approval-closed`): answered, timed out, or the run stopped. This
 * module shows what the server says and sends the person's answer back.
 *
 * Hiding the picker is not an answer. VS Code hides it for Escape, and also
 * whenever another quick input opens (Ctrl+P), which a person would not mean
 * as a Deny. A hidden question stays open, a status-bar item says so and
 * brings it back, and the server's timeout ends it if nobody does.
 *
 * Two runs in one window — two files, each in its own session — can each have
 * a question open. They queue: one picker at a time, the next shown when the
 * one before it closes.
 */

import * as vscode from 'vscode';
import type { AgentApprovalAnswer } from 'steptix-runner-core';
import { approvalChoices, approvalTitle, type ApprovalChoice } from './agent-approval-core.js';

export interface ApprovalRequest {
  requestId: string;
  command: string;
  folder: string;
  step: string;
  pattern: string;
  expiresAt: string;
}

interface Pending {
  request: ApprovalRequest;
  /** The run it belongs to — the test file's URI — so that run's end closes it. */
  owner: string;
  send: (answer: AgentApprovalAnswer) => Promise<boolean>;
  answered: boolean;
}

type Item = vscode.QuickPickItem & ApprovalChoice;

export class AgentApprovalPrompt implements vscode.Disposable {
  private readonly queue: Pending[] = [];
  private shown: { pending: Pending; pick: vscode.QuickPick<Item>; timer: NodeJS.Timeout } | undefined;
  private readonly status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 1000);
  private readonly reopen: vscode.Disposable;

  constructor(private readonly now: () => number = Date.now) {
    this.status.command = 'steptix.agentApproval.show';
    this.reopen = vscode.commands.registerCommand('steptix.agentApproval.show', () => this.showHead());
  }

  /** A question opened. Shown now, or after the ones before it close. */
  show(request: ApprovalRequest, owner: string, send: (answer: AgentApprovalAnswer) => Promise<boolean>): void {
    this.queue.push({ request, owner, send, answered: false });
    this.refreshStatus();
    if (!this.shown) this.showHead();
  }

  /** The server closed a question: drop it without answering. */
  close(requestId: string): void {
    const index = this.queue.findIndex((p) => p.request.requestId === requestId);
    if (index < 0) return;
    const [removed] = this.queue.splice(index, 1);
    if (this.shown?.pending === removed) this.hideShown();
    this.refreshStatus();
    if (!this.shown && this.queue.length > 0) this.showHead();
  }

  /** A run ended (its `done`, or a Stop): its questions are over, whether or
   *  not the server's close reached this window. */
  closeFor(owner: string): void {
    for (const p of [...this.queue]) if (p.owner === owner) this.close(p.request.requestId);
  }

  /** True while any question is open, for the run panel's line. */
  get waiting(): boolean {
    return this.queue.length > 0;
  }

  private showHead(): void {
    const pending = this.queue[0];
    if (!pending) return;
    if (this.shown?.pending === pending) {
      this.shown.pick.show();
      return;
    }
    this.hideShown();
    const { request } = pending;
    const pick = vscode.window.createQuickPick<Item>();
    const expires = Date.parse(request.expiresAt);
    const secondsLeft = (): number => Math.ceil((expires - this.now()) / 1000);
    pick.title = approvalTitle(secondsLeft());
    pick.placeholder = `${request.command} — in ${request.folder || 'the workspace'} · ${request.step}`;
    pick.items = approvalChoices(request.pattern);
    pick.ignoreFocusOut = true;
    pick.onDidAccept(() => {
      const chosen = pick.selectedItems[0];
      if (!chosen || pending.answered) return;
      pending.answered = true;
      // An answer that did not reach an open question (the network, or the
      // server had just closed it) leaves the question unanswered: shown as
      // waiting again while it is still queued, rather than as answered.
      void pending
        .send(chosen.answer)
        .catch(() => false)
        .then((delivered) => {
          if (delivered || !this.queue.includes(pending)) return;
          pending.answered = false;
          this.refreshStatus();
        });
      // The server's close event takes it off the queue; until then it is
      // hidden, and the next question waits for that close.
      pick.hide();
    });
    pick.onDidHide(() => {
      // Not an answer (see the file docstring). The status bar brings it back.
      this.refreshStatus();
    });
    const timer = setInterval(() => {
      pick.title = approvalTitle(secondsLeft());
    }, 1000);
    this.shown = { pending, pick, timer };
    pick.show();
  }

  private hideShown(): void {
    if (!this.shown) return;
    const { pick, timer } = this.shown;
    this.shown = undefined;
    clearInterval(timer);
    pick.hide();
    pick.dispose();
  }

  private refreshStatus(): void {
    const unanswered = this.queue.filter((p) => !p.answered);
    if (unanswered.length === 0) {
      this.status.hide();
      return;
    }
    this.status.text =
      unanswered.length === 1
        ? '$(shield) Steptix: waiting for your approval'
        : `$(shield) Steptix: ${unanswered.length} commands waiting for your approval`;
    this.status.tooltip = `The agent wants to run: ${unanswered[0]!.request.command}. Click to answer.`;
    this.status.show();
  }

  dispose(): void {
    this.queue.length = 0;
    this.hideShown();
    this.status.dispose();
    this.reopen.dispose();
  }
}
