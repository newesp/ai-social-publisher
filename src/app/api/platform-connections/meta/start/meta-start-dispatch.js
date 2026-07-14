export function dispatchMetaStartRequest(request, handlers) {
  const contentType = String(request.headers.get("content-type") ?? "").split(";", 1)[0].trim().toLowerCase();
  if (contentType === "application/x-www-form-urlencoded") return handlers.startMetaRedirect(request);
  return handlers.startMeta(request);
}
