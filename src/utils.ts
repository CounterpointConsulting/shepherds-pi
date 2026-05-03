/**
 * Normalize a path from import.meta.url.pathname on Windows.
 * On Windows, the pathname starts with /C:/ which causes path.resolve to double the drive.
 */
export function normalizeImportMetaPath(pathname: string): string {
  if (pathname.startsWith('/') && pathname.length > 2 && pathname.charAt(2) === ':') {
    return pathname.substring(1);
  }
  return pathname;
}

/**
 * Get the directory of the current module file, cross-platform.
 */
export function getModuleDir(importMetaUrl: string): string {
  const pathname = normalizeImportMetaPath(new URL(importMetaUrl).pathname);
  return path.dirname(pathname);
}

import path from 'node:path';

/**
 * Format elapsed time between two ISO timestamps.
 */
export function getElapsed(startedAt: string, completedAt?: string): string {
  const start = new Date(startedAt).getTime();
  const end = completedAt ? new Date(completedAt).getTime() : Date.now();
  const seconds = Math.floor((end - start) / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m ${remainingSeconds}s`;
}
