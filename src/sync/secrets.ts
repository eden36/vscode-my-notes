import * as vscode from 'vscode';
import { getSyncConfig } from '../config';

/** 需要凭据的同步后端（`none` 不涉及凭据） */
export type CredentialProvider = 'git' | 'webdav';

/**
 * 凭据按「后端 + 目标地址」分别存储，切换仓库或服务器后不会误用旧凭据。
 * 全部走 SecretStorage，不写入 settings.json。
 */
function secretKey(provider: CredentialProvider, target: string): string {
  return `mynotes.${provider}:${target}`;
}

/**
 * 取得指定后端当前配置对应的凭据键；对应地址未填写时返回 undefined。
 * 按后端而非「当前启用的后端」取键，设置页才能同时管理 Git 与 WebDAV 两套凭据。
 */
export function secretKeyFor(provider: CredentialProvider): string | undefined {
  const cfg = getSyncConfig();
  const target = provider === 'git' ? cfg.git.remoteUrl : cfg.webdav.url;
  return target ? secretKey(provider, target) : undefined;
}

/** 返回当前启用的后端对应的凭据键；未启用同步或配置不完整时返回 undefined */
export function currentSecretKey(): string | undefined {
  const provider = getSyncConfig().provider;
  return provider === 'none' ? undefined : secretKeyFor(provider);
}

export async function getSecretFor(
  context: vscode.ExtensionContext,
  provider: CredentialProvider,
): Promise<string | undefined> {
  const key = secretKeyFor(provider);
  return key ? context.secrets.get(key) : undefined;
}

export async function setSecretFor(
  context: vscode.ExtensionContext,
  provider: CredentialProvider,
  value: string,
): Promise<boolean> {
  const key = secretKeyFor(provider);
  if (!key) {
    return false;
  }
  await context.secrets.store(key, value);
  return true;
}

export async function deleteSecretFor(
  context: vscode.ExtensionContext,
  provider: CredentialProvider,
): Promise<boolean> {
  const key = secretKeyFor(provider);
  if (!key) {
    return false;
  }
  await context.secrets.delete(key);
  return true;
}

export async function getSecret(context: vscode.ExtensionContext): Promise<string | undefined> {
  const key = currentSecretKey();
  return key ? context.secrets.get(key) : undefined;
}

export async function setSecret(context: vscode.ExtensionContext, value: string): Promise<void> {
  const key = currentSecretKey();
  if (key) {
    await context.secrets.store(key, value);
  }
}

export async function deleteSecret(context: vscode.ExtensionContext): Promise<void> {
  const key = currentSecretKey();
  if (key) {
    await context.secrets.delete(key);
  }
}
