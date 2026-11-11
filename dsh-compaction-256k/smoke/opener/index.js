import { internals } from "@deepseek-ai/dsh-web-app";

export const inject = ["connection", "webApp"];

/** Use the shipped handoff without printing or returning the process-token URL. */
export async function apply(ctx) {
  const url = ctx.connection.authenticatedUrl(ctx.webApp.getAdvertisedUrl());
  try {
    await internals.openBrowser(url);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Authenticated browser handoff failed: ${message.split(url).join("<redacted>")}`);
  }
}
