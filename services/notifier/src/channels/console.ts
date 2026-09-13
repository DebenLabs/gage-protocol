import type { ChannelName } from "../auth.js";
import type { Logger } from "../log.js";
import type { Channel } from "./types.js";

/** Used whenever a channel's credentials are missing: logs the message, marks the send `dry`. */
export function consoleChannel(name: ChannelName, log: Logger, validateAddress: Channel["validateAddress"]): Channel {
  return {
    name,
    dry: true,
    validateAddress,
    send: (address, message) => {
      log.info("dry_send", { channel: name, to: address, subject: message.subject, text: message.text });
      return Promise.resolve({});
    },
  };
}
