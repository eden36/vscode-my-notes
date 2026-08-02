import * as vscode from 'vscode';

let channel: vscode.LogOutputChannel | undefined;

export function initLog(context: vscode.ExtensionContext): void {
  channel = vscode.window.createOutputChannel('MyNotes', { log: true });
  context.subscriptions.push(channel);
}

/** 把任意抛出物整理成可读文本，保留堆栈便于排查 */
export function describeError(err: unknown): string {
  if (err instanceof Error) {
    return err.stack ? `${err.message}\n${err.stack}` : err.message;
  }
  return String(err);
}

export const log = {
  trace(message: string, ...args: unknown[]): void {
    channel?.trace(message, ...args);
  },
  info(message: string, ...args: unknown[]): void {
    channel?.info(message, ...args);
  },
  warn(message: string, ...args: unknown[]): void {
    channel?.warn(message, ...args);
  },
  error(message: string, err?: unknown): void {
    channel?.error(err === undefined ? message : `${message}: ${describeError(err)}`);
  },
  show(): void {
    channel?.show(true);
  },
};
