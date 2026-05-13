/**
 * API key extraction and validation.
 * Pure functions with no runtime dependencies (testable without CF Workers).
 */

export function extractApiKey(headers: Headers | Record<string, string | null>): string | null {
  const get = (name: string) => {
    if (headers instanceof Headers) return headers.get(name);
    return (headers as Record<string, string | null>)[name.toLowerCase()] || null;
  };
  return get("X-Api-Key") || get("Authorization")?.replace("Bearer ", "")?.trim() || null;
}

export interface AuthError {
  status: number;
  body: Record<string, unknown>;
}

export function validateApiKey(key: string | null): AuthError | null {
  if (!key) {
    return {
      status: 401,
      body: { error: { type: "authentication_error", message: "Missing API key. Provide x-api-key header." } },
    };
  }
  if (key.length < 32) {
    return {
      status: 401,
      body: { error: { type: "authentication_error", message: "Invalid API key: must be at least 32 characters." } },
    };
  }
  return null;
}

export function authErrorResponse(err: AuthError): Response {
  return new Response(JSON.stringify(err.body), {
    status: err.status,
    headers: { "Content-Type": "application/json" },
  });
}
