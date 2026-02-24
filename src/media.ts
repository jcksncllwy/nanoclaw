import fs from 'fs';
import path from 'path';

import { MEDIA_DIR } from './config.js';
import { logger } from './logger.js';

export function sanitizeFilename(name: string): string {
  // Strip path separators and null bytes, limit length
  return name
    .replace(/[/\\:\0]/g, '_')
    .replace(/\.{2,}/g, '.')
    .slice(0, 200);
}

export function buildMediaPath(groupFolder: string, messageId: string, filename: string): string {
  const safe = sanitizeFilename(filename);
  return path.join(MEDIA_DIR, groupFolder, `${messageId}-${safe}`);
}

export function containerMediaPath(messageId: string, filename: string): string {
  const safe = sanitizeFilename(filename);
  return `/workspace/media/${messageId}-${safe}`;
}

export async function downloadAttachment(url: string, destPath: string): Promise<void> {
  fs.mkdirSync(path.dirname(destPath), { recursive: true });

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Download failed: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
  logger.debug({ destPath, size: buffer.length }, 'Attachment downloaded');
}

export function formatSize(bytes: number | null): string {
  if (bytes === null || bytes === undefined) return 'unknown size';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}
