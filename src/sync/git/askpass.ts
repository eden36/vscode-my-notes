import * as vscode from 'vscode';
import { log } from '../../log';

/** git 只接受可执行文件作为 GIT_ASKPASS，这里生成一层壳脚本转调 Node */
const WRAPPER_WINDOWS = [
  '@ECHO OFF',
  '"%SYNCNOTES_ASKPASS_NODE%" "%SYNCNOTES_ASKPASS_MAIN%" %*',
  '',
].join('\r\n');

const WRAPPER_POSIX = ['#!/bin/sh', 'exec "$SYNCNOTES_ASKPASS_NODE" "$SYNCNOTES_ASKPASS_MAIN" "$@"', ''].join('\n');

export interface Credentials {
  username: string;
  password: string;
}

/**
 * 准备 GIT_ASKPASS 壳脚本并返回注入给 git 的环境变量。
 *
 * 用 VS Code 自身的可执行文件（配合 ELECTRON_RUN_AS_NODE）跑脚本，
 * 免去对用户机器上 node 的依赖。
 */
export async function buildAskpassEnv(
  context: vscode.ExtensionContext,
  credentials: Credentials,
): Promise<Record<string, string>> {
  const isWindows = process.platform === 'win32';
  const wrapperName = isWindows ? 'syncnotes-askpass.bat' : 'syncnotes-askpass.sh';
  const wrapperUri = vscode.Uri.joinPath(context.globalStorageUri, wrapperName);
  const mainUri = vscode.Uri.joinPath(context.extensionUri, 'dist', 'askpassMain.js');

  await vscode.workspace.fs.createDirectory(context.globalStorageUri);
  await vscode.workspace.fs.writeFile(
    wrapperUri,
    Buffer.from(isWindows ? WRAPPER_WINDOWS : WRAPPER_POSIX, 'utf8'),
  );

  if (!isWindows) {
    try {
      const { chmod } = await import('fs/promises');
      await chmod(wrapperUri.fsPath, 0o755);
    } catch (err) {
      log.warn(`设置 askpass 脚本可执行权限失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return {
    GIT_ASKPASS: wrapperUri.fsPath,
    SYNCNOTES_ASKPASS_NODE: process.execPath,
    SYNCNOTES_ASKPASS_MAIN: mainUri.fsPath,
    ELECTRON_RUN_AS_NODE: '1',
    SYNCNOTES_GIT_USERNAME: credentials.username,
    SYNCNOTES_GIT_PASSWORD: credentials.password,
  };
}

/** SSH 地址无法用 askpass 注入凭据，只能依赖本机 ssh-agent */
export function isSshRemote(remoteUrl: string): boolean {
  return /^(ssh:\/\/|[\w.-]+@[\w.-]+:)/.test(remoteUrl);
}
