import { config } from "../config.js";
import type { NotifyInput } from "../graph/state.js";
import { errorMessage, log } from "../log.js";
import { sendEmailAlert } from "./email.js";
import { sendSlackAlert } from "./slack.js";

/** Some channels still failed after their retries. `delivered` lists the ones that worked. */
export class AlertDeliveryError extends Error {
  constructor(
    readonly delivered: string[],
    readonly failed: { channel: string; error: string }[],
  ) {
    super(`alert delivery failed: ${failed.map((f) => `${f.channel} (${f.error})`).join("; ")}`);
    this.name = "AlertDeliveryError";
  }
}

export type AlertChannel = [name: string, send: () => Promise<boolean>];

/**
 * Sends every configured alert, retrying each channel with backoff so a brief
 * outage does not lose the alert. Returns the channels that delivered; throws
 * `AlertDeliveryError` (carrying those channels) when any channel still failed.
 */
export async function notifyCritical(
  input: NotifyInput,
  opts: { channels?: AlertChannel[]; attempts?: number; backoffMs?: number } = {},
): Promise<string[]> {
  const channels = opts.channels ?? [
    ["slack", () => sendSlackAlert(input)],
    ["email", () => sendEmailAlert(input)],
  ];
  const attempts = opts.attempts ?? config.ALERT_ATTEMPTS;
  const backoffMs = opts.backoffMs ?? 2_000;
  const delivered: string[] = [];
  const failed: { channel: string; error: string }[] = [];
  for (const [name, send] of channels) {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        if (await send()) delivered.push(name);
        break;
      } catch (err) {
        // One channel failing should not stop the other.
        if (attempt < attempts) {
          log.warn("alert delivery failed, will retry", { channel: name, attempt, error: errorMessage(err) });
          await new Promise((r) => setTimeout(r, backoffMs * 2 ** (attempt - 1)));
        } else {
          log.error("alert delivery failed", { channel: name, attempts, error: errorMessage(err) });
          failed.push({ channel: name, error: errorMessage(err) });
        }
      }
    }
  }
  if (failed.length > 0) throw new AlertDeliveryError(delivered, failed);
  return delivered;
}
