import type { ChannelName } from "../auth.js";
import type { Rendered } from "../messages.js";

export interface SendReceipt {
  /** Provider message id when there is one. */
  id?: string;
}

export interface Channel {
  readonly name: ChannelName;
  /** True for the console adapter: nothing leaves the process, sends are recorded as `dry`. */
  readonly dry: boolean;
  /** Whether `address` is an acceptable destination for this channel. */
  validateAddress(address: string): string | undefined;
  send(address: string, message: Rendered): Promise<SendReceipt>;
}

export type Channels = Record<ChannelName, Channel>;
