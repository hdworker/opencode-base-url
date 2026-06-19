import { mkdir, appendFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';

const LOG_DIR = join(process.cwd(), 'logs');

export async function ensureLogDir(): Promise<void> {
  if (!existsSync(LOG_DIR)) {
    await mkdir(LOG_DIR, { recursive: true });
  }
}

export async function logRequest(request: Request, response?: Response): Promise<void> {
  await ensureLogDir();

  const now = new Date().toISOString();
  const url = request.url;
  const method = request.method;
  const path = new URL(url).pathname;
  const status = response?.status ?? 'pending';
  const userAgent = request.headers.get('user-agent') || 'unknown';

  const line = JSON.stringify({
    timestamp: now,
    method,
    path,
    url,
    status,
    userAgent,
  }) + '\n';

  const logFile = join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  await appendFile(logFile, line);
}

export async function logError(error: Error, request?: Request): Promise<void> {
  await ensureLogDir();

  const now = new Date().toISOString();
  const line = JSON.stringify({
    timestamp: now,
    level: 'ERROR',
    message: error.message,
    stack: error.stack,
    url: request?.url,
  }) + '\n';

  const logFile = join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  await appendFile(logFile, line);
}
