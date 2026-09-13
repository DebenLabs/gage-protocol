import type { NotifierConfig, NotifierSecrets } from "../config.js";
import type { Logger } from "../log.js";
import { consoleChannel } from "./console.js";
import { resendChannel, validateEmail } from "./email.js";
import { pushChannel, validatePush } from "./push.js";
import { telegramApi, telegramChannel, validateTelegram, type TelegramApi } from "./telegram.js";
import type { Channels } from "./types.js";

export type { Channel, Channels, SendReceipt } from "./types.js";

/** One adapter per channel; the console adapter stands in wherever credentials are missing. */
export function buildChannels(config: NotifierConfig, secrets: NotifierSecrets, log: Logger): { channels: Channels; telegram: TelegramApi | undefined } {
  const telegram = secrets.telegramBotToken === undefined ? undefined : telegramApi({ botToken: secrets.telegramBotToken });
  const channels: Channels = {
    email:
      config.email.configured && secrets.resendApiKey !== undefined && config.email.from !== undefined
        ? resendChannel({ apiKey: secrets.resendApiKey, from: config.email.from })
        : consoleChannel("email", log, validateEmail),
    telegram: telegram === undefined ? consoleChannel("telegram", log, validateTelegram) : telegramChannel(telegram),
    push:
      config.push.configured && config.push.publicKey !== undefined && secrets.vapidPrivateKey !== undefined
        ? pushChannel({ publicKey: config.push.publicKey, privateKey: secrets.vapidPrivateKey, subject: config.push.subject })
        : consoleChannel("push", log, validatePush),
  };
  return { channels, telegram };
}
