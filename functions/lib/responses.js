export class ApiError extends Error {
  constructor(status, code, details = undefined) {
    super(code);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

export function json(body, status = 200, headers = undefined) {
  const responseHeaders = new Headers(headers);
  responseHeaders.set("content-type", "application/json; charset=utf-8");
  responseHeaders.set("cache-control", "no-store");
  return new Response(JSON.stringify(body), { status, headers: responseHeaders });
}

export async function readJson(request) {
  let value;
  try {
    value = await request.json();
  } catch {
    throw new ApiError(400, "invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_json_body");
  }
  return value;
}

export async function readOptionalJson(request) {
  let text;
  try {
    text = await request.text();
  } catch {
    throw new ApiError(400, "invalid_json");
  }
  if (text.trim() === "") return {};
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ApiError(400, "invalid_json");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ApiError(400, "invalid_json_body");
  }
  return value;
}

export function methodNotAllowed(methods) {
  return json({ error: "method_not_allowed" }, 405, { allow: methods.join(", ") });
}

export function errorResponse(error) {
  if (error instanceof ApiError) {
    const body = { error: error.code };
    if (error.details && typeof error.details === "object") Object.assign(body, error.details);
    return json(body, error.status);
  }
  return json({ error: "server_error" }, 500);
}
