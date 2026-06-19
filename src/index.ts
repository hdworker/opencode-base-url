import { Hono } from 'hono';
import { extractApiKey, validateApiKey, authErrorResponse } from './auth';
import { formatAnthropicToOpenAI } from './translate/request/anthropic-to-openai';
import { formatOpenAIToAnthropic } from './translate/request/openai-to-anthropic';
import { formatOpenAIToAnthropic as toAnthropicResponse } from './translate/response/openai-to-anthropic';
import { formatAnthropicToOpenAI as toOpenAIResponse } from './translate/response/anthropic-to-openai';
import { streamOpenAIToAnthropic } from './translate/stream/openai-to-anthropic';
import { streamAnthropicToOpenAI } from './translate/stream/anthropic-to-openai';
import { logRequest, logError } from './logger';

const GO_UPSTREAM = "https://opencode.ai/zen/go/v1";
const ZEN_UPSTREAM = "https://opencode.ai/zen/v1";
const DEFAULT_UPSTREAM = GO_UPSTREAM;
const VISION_MODEL = "qwen3.5-plus";

interface RouteConfig {
  path: string;
  upstream: string;
}

function stripPrefix(path: string, prefix: string): string | null {
  if (path === prefix) return "/";
  if (path.startsWith(`${prefix}/`)) return path.slice(prefix.length);
  return null;
}

function routeConfig(request: Request): RouteConfig {
  const path = new URL(request.url).pathname;
  const goPath = stripPrefix(path, "/go");
  if (goPath) return { path: goPath, upstream: GO_UPSTREAM };

  const zenPath = stripPrefix(path, "/zen");
  if (zenPath) return { path: zenPath, upstream: ZEN_UPSTREAM };

  return { path, upstream: DEFAULT_UPSTREAM };
}

function getUpstream(request: Request, routeUpstream: string): string {
  return request.headers.get("X-Upstream-Url") || routeUpstream;
}

function upstreamFormat(request: Request): "openai" | "anthropic" {
  const fmt = (request.headers.get("X-Upstream-Format") || "openai").toLowerCase();
  return fmt === "anthropic" ? "anthropic" : "openai";
}

function anthropicHeaders(request: Request, key: string): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-Api-Key": key,
    "Anthropic-Version": request.headers.get("Anthropic-Version") || "2023-06-01",
  };
  const beta = request.headers.get("Anthropic-Beta");
  if (beta) headers["Anthropic-Beta"] = beta;
  return headers;
}

function hasImages(body: any): boolean {
  const messages = body?.messages;
  if (!Array.isArray(messages)) return false;
  return messages.some((msg: any) =>
    Array.isArray(msg.content) && msg.content.some((part: any) => part.type === "image")
  );
}

function upstreamErrorResponse(res: Response, body: string): Response {
  const headers = new Headers();
  for (const name of ["Content-Type", "Retry-After", "RateLimit-Limit", "RateLimit-Remaining", "RateLimit-Reset"]) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(body, { status: res.status, headers });
}

async function handleRequest(request: Request): Promise<Response> {
  const route = routeConfig(request);
  const upstream = getUpstream(request, route.upstream);
  const fmt = upstreamFormat(request);

  console.log(`[${new Date().toISOString()}] ${request.method} ${request.url} -> route: ${route.path}, upstream: ${upstream}, format: ${fmt}`);

  // Anthropic → OpenAI (for Claude Desktop/Cowork → any OpenAI API)
  if (route.path === '/v1/messages' && request.method === 'POST') {
      const key = extractApiKey(request.headers);
      const err = validateApiKey(key);
      if (err) {
        console.log(`[AUTH] Rejected: ${JSON.stringify(err.body)}`);
        const resp = authErrorResponse(err);
        await logRequest(request, resp);
        return resp;
      }

      if (fmt === "openai") {
        const req = await request.json();
        console.log(`[TRANSLATE] Anthropic→OpenAI, model: ${req.model}, stream: ${req.stream}`);
        if (hasImages(req)) {
          console.log(`[IMAGE] Detected image, overriding model to ${VISION_MODEL}`);
          req.model = VISION_MODEL;
        }
        const openaiReq = formatAnthropicToOpenAI(req);
        let res: Response;
        try {
          res = await fetch(`${upstream}/chat/completions`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Authorization": `Bearer ${key}`,
            },
            body: JSON.stringify(openaiReq),
          });
        } catch (err: any) {
          const cause = err.cause?.message || err.message || 'Unknown error';
          console.error(`[TRANSLATE ERROR] Anthropic→OpenAI: ${cause}`);
          await logError(err, request).catch(() => {});
          return new Response(JSON.stringify({
            error: { message: `Upstream connection failed: ${cause}`, type: 'upstream_error' },
          }), { status: 502, headers: { "Content-Type": "application/json" } });
        }
        if (!res.ok) {
          console.log(`[UPSTREAM ERROR] ${res.status} ${res.statusText}`);
          const resp = upstreamErrorResponse(res, await res.text());
          await logRequest(request, resp);
          return resp;
        }

        if (openaiReq.stream) {
          console.log(`[STREAM] OpenAI→Anthropic streaming`);
          const resp = new Response(streamOpenAIToAnthropic(res.body as ReadableStream, openaiReq.model), {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
          await logRequest(request, resp);
          return resp;
        }
        const data: any = await res.json();
        console.log(`[RESPONSE] Non-streaming, model: ${openaiReq.model}`);
        const resp = new Response(JSON.stringify(toAnthropicResponse(data, openaiReq.model)), {
          headers: { "Content-Type": "application/json" },
        });
        await logRequest(request, resp);
        return resp;
      }

      // Pass-through to Anthropic upstream
      console.log(`[PASSTHROUGH] Anthropic→Anthropic`);
      const anthBody = await request.text();
      try {
        const res = await fetch(`${upstream}/v1/messages`, {
          method: "POST",
          headers: anthropicHeaders(request, key!),
          body: anthBody,
        });
        await logRequest(request, res);
        return res;
      } catch (err: any) {
        const cause = err.cause?.message || err.message || 'Unknown error';
        console.error(`[PASSTHROUGH ERROR] Anthropic→Anthropic: ${cause}`);
        await logError(err, request).catch(() => {});
        return new Response(JSON.stringify({
          error: { message: `Upstream connection failed: ${cause}`, type: 'upstream_error' },
        }), { status: 502, headers: { "Content-Type": "application/json" } });
      }
  }

  // OpenAI → Anthropic (or pass-through)
  const isChatCompletions = route.path === '/v1/chat/completions' || route.path === '/chat/completions';
  if (isChatCompletions && request.method === 'POST') {
      const key = extractApiKey(request.headers);
      const err = validateApiKey(key);
      if (err) {
        console.log(`[AUTH] Rejected: ${JSON.stringify(err.body)}`);
        const resp = authErrorResponse(err);
        await logRequest(request, resp);
        return resp;
      }

      if (fmt === "anthropic") {
        const req = await request.json();
        console.log(`[TRANSLATE] OpenAI→Anthropic, model: ${req.model}, stream: ${req.stream}`);
        const anthReq = formatOpenAIToAnthropic(req);
        let res: Response;
        try {
          res = await fetch(`${upstream}/v1/messages`, {
            method: "POST",
            headers: anthropicHeaders(request, key!),
            body: JSON.stringify(anthReq),
          });
        } catch (err: any) {
          const cause = err.cause?.message || err.message || 'Unknown error';
          console.error(`[TRANSLATE ERROR] OpenAI→Anthropic: ${cause}`);
          await logError(err, request).catch(() => {});
          return new Response(JSON.stringify({
            error: { message: `Upstream connection failed: ${cause}`, type: 'upstream_error' },
          }), { status: 502, headers: { "Content-Type": "application/json" } });
        }
        if (!res.ok) {
          console.log(`[UPSTREAM ERROR] ${res.status} ${res.statusText}`);
          const resp = upstreamErrorResponse(res, await res.text());
          await logRequest(request, resp);
          return resp;
        }

        if (anthReq.stream) {
          console.log(`[STREAM] Anthropic→OpenAI streaming`);
          const resp = new Response(streamAnthropicToOpenAI(res.body as ReadableStream, anthReq.model), {
            headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
          });
          await logRequest(request, resp);
          return resp;
        }
        const data: any = await res.json();
        console.log(`[RESPONSE] Non-streaming, model: ${anthReq.model}`);
        const resp = new Response(JSON.stringify(toOpenAIResponse(data, anthReq.model)), {
          headers: { "Content-Type": "application/json" },
        });
        await logRequest(request, resp);
        return resp;
      }

      // Pass-through to OpenAI upstream
      console.log(`[PASSTHROUGH] OpenAI→OpenAI`);
      const textBody = await request.text();
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          const res = await fetch(`${upstream}/chat/completions`, {
            method: "POST",
            headers: { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
            body: textBody,
          });
          await logRequest(request, res);
          return res;
        } catch (err: any) {
          const cause = err.cause?.message || err.message || 'Unknown error';
          console.error(`[PASSTHROUGH ERROR] attempt ${attempt}/2: ${cause}`);
          await logError(err, request).catch(() => {});
          if (attempt === 2) {
            return new Response(JSON.stringify({
              error: { message: `Upstream connection failed: ${cause}`, type: 'upstream_error' },
            }), { status: 502, headers: { "Content-Type": "application/json" } });
          }
          await new Promise(r => setTimeout(r, 1000 * attempt));
        }
      }
  }

  // Model discovery
  const isModels = route.path === '/v1/models' || route.path === '/models';
  if (isModels && request.method === 'GET') {
      const key = extractApiKey(request.headers);
      const err = validateApiKey(key);
      if (err) {
        console.log(`[AUTH] Rejected: ${JSON.stringify(err.body)}`);
        const resp = authErrorResponse(err);
        await logRequest(request, resp);
        return resp;
      }

      console.log(`[MODELS] Discovering models, format: ${fmt}`);
      const res = fmt === "anthropic"
        ? await fetch(`${upstream}/v1/models`, {
            method: "GET",
            headers: anthropicHeaders(request, key!),
          })
        : await fetch(`${upstream}/models`, {
            method: "GET",
            headers: { "Authorization": `Bearer ${key}` },
      });
      if (!res.ok) {
        console.log(`[UPSTREAM ERROR] ${res.status} ${res.statusText}`);
        const resp = upstreamErrorResponse(res, await res.text());
        await logRequest(request, resp);
        return resp;
      }
      const resp = new Response(await res.text(), { headers: { "Content-Type": "application/json" } });
      await logRequest(request, resp);
      return resp;
  }

  console.log(`[404] No route matched for path: ${route.path}`);
  const resp = new Response(JSON.stringify({
    name: "opencode-cowork-proxy",
    upstream,
    routes: {
      "/go": GO_UPSTREAM,
      "/zen": ZEN_UPSTREAM,
    },
    endpoints: {
      "/v1/messages": "Anthropic → upstream (translated if upstream=openai)",
      "/v1/chat/completions": "OpenAI → upstream (translated if upstream=anthropic)",
      "/v1/models": "Model discovery proxy",
    },
  }, null, 2), {
    headers: { "Content-Type": "application/json" },
    status: route.path === '/' ? 200 : 404,
  });
  await logRequest(request, resp);
  return resp;
}

const app = new Hono();
app.all('*', (c) => handleRequest(c.req.raw));

export { app };
export default app;
