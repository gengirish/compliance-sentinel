import type { NotifyInput } from "../graph/state.js";
import { errorMessage, log } from "../log.js";
import { sendEmailAlert } from "./email.js";
import { sendSlackAlert } from "./slack.js";

/** Sends every configured alert. Returns the channels that actually delivered. */
export async function notifyCritical(input: NotifyInput): Promise<string[]> {
  const delivered: string[] = [];
  const channels: [string, () => Promise<boolean>][] = [
    ["slack", () => sendSlackAlert(input)],
    ["email", () => sendEmailAlert(input)],
  ];
  for (const [name, send] of channels) {
    try {
      if (await send()) delivered.push(name);
    } catch (err) {
      // One channel failing should not stop the other.
      log.error("alert delivery failed", { channel: name, error: errorMessage(err) });
    }
  }
  return delivered;
}
