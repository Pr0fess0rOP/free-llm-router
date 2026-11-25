import type { IncomingMessage, ServerResponse } from "node:http";
import { handleRequest } from "../src/server.js";

export default async function handler(
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  let incomingUrl: URL;
  try {
    incomingUrl = new URL(request.url ?? "/", "http://localhost");
  } catch {
    await handleRequest(request, response);
    return;
  }
  const routedPath = incomingUrl.searchParams.get("__route");

  if (routedPath) {
    incomingUrl.searchParams.delete("__route");
    const remainingQuery = incomingUrl.searchParams.toString();
    request.url = remainingQuery
      ? `${routedPath}?${remainingQuery}`
      : routedPath;
  }

  await handleRequest(request, response);
}
