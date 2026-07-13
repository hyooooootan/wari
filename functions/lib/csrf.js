import { ApiError } from "./responses.js";

export function assertOrigin(request, env, options = {}) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) return;
  const expected = env.APP_ORIGIN || new URL(request.url).origin;
  const origin = request.headers.get("origin");
  if (options.requireOrigin && !origin) throw new ApiError(403, "invalid_origin");
  if (origin && origin !== expected) throw new ApiError(403, "invalid_origin");
  const contentType = request.headers.get("content-type");
  if (options.requireJson && contentType?.split(";", 1)[0].trim().toLowerCase() !== "application/json") {
    throw new ApiError(415, "unsupported_content_type");
  }
  if (contentType && !contentType.toLowerCase().startsWith("application/json") && !contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")) {
    throw new ApiError(415, "unsupported_content_type");
  }
}
