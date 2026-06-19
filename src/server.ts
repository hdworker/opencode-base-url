import { serve } from '@hono/node-server';
import { app } from './index';

const port = parseInt(process.env.PORT || '3000', 10);
const timeout = parseInt(process.env.TIMEOUT || '10000', 10);

console.log(`Starting opencode-cowork-proxy on port ${port}, timeout ${timeout}ms`);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const response = await originalFetch(input, {
      ...init,
      signal: controller.signal,
    });
    return response;
  } catch (err: any) {
    if (err.name === 'AbortError' || err.code === 'UND_ERR_CONNECT_TIMEOUT') {
      console.error(`[TIMEOUT] Request to ${typeof input === 'string' ? input : 'upstream'} exceeded ${timeout}ms`);
      throw new Error(`Request timeout after ${timeout}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
};

serve({
  fetch: app.fetch,
  port,
});

export default app;