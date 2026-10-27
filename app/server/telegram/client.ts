// Minimal Telegram Bot API client over fetch (no dependency). The token is part of
// every request URL, so it is scrubbed from any error before the error leaves here.

export interface TgUser {
  id: number;
  is_bot?: boolean;
  username?: string;
}

export interface TgChat {
  id: number;
  type: "private" | "group" | "supergroup" | "channel";
}

export interface TgMessage {
  message_id: number;
  from?: TgUser;
  chat: TgChat;
  date: number;
  text?: string;
}

export interface TgCallbackQuery {
  id: string;
  from: TgUser;
  message?: TgMessage;
  data?: string;
}

export interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: TgCallbackQuery;
}

export interface Button {
  text: string;
  data: string;
}

/** What the bot needs from Telegram. Tests implement it with a recorder. */
export interface TelegramApi {
  sendMessage(chatId: string, text: string, buttons?: Button[][]): Promise<{ messageId: number }>;
  editMessage(chatId: string, messageId: number, text: string, buttons?: Button[][]): Promise<void>;
  answerCallback(callbackId: string, text?: string): Promise<void>;
}

export class HttpTelegram implements TelegramApi {
  constructor(
    private readonly token: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {
    if (!/^\d+:[A-Za-z0-9_-]{30,}$/.test(token)) throw new Error("TELEGRAM_BOT_TOKEN is not a bot token (expected <id>:<secret>)");
  }

  private scrub(message: string) {
    return message.split(this.token).join("<token>");
  }

  async call<T>(method: string, body: Record<string, unknown>, timeoutMs = 15_000): Promise<T> {
    let res: Response;
    try {
      res = await this.fetchImpl(`https://api.telegram.org/bot${this.token}/${method}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new Error(`telegram ${method}: ${this.scrub((e as Error).message)}`);
    }
    const data = (await res.json().catch(() => ({}))) as { ok?: boolean; result?: T; description?: string };
    if (!data.ok) throw new Error(`telegram ${method}: ${res.status} ${this.scrub(String(data.description ?? "")).slice(0, 160)}`);
    return data.result as T;
  }

  getMe() {
    return this.call<TgUser>("getMe", {});
  }

  /** Long poll. Only message and callback_query updates are requested. */
  getUpdates(offset: number, timeoutSec: number) {
    return this.call<TgUpdate[]>("getUpdates", { offset, timeout: timeoutSec, allowed_updates: ["message", "callback_query"] }, (timeoutSec + 10) * 1000);
  }

  /** Polling and webhooks are exclusive; polling needs any old webhook removed. */
  async deleteWebhook() {
    await this.call("deleteWebhook", { drop_pending_updates: false });
  }

  async sendMessage(chatId: string, text: string, buttons?: Button[][]) {
    const m = await this.call<TgMessage>("sendMessage", { chat_id: chatId, text, ...markup(buttons), link_preview_options: { is_disabled: true } });
    return { messageId: m.message_id };
  }

  async editMessage(chatId: string, messageId: number, text: string, buttons?: Button[][]) {
    await this.call("editMessageText", { chat_id: chatId, message_id: messageId, text, ...markup(buttons) });
  }

  async answerCallback(callbackId: string, text?: string) {
    await this.call("answerCallbackQuery", { callback_query_id: callbackId, ...(text ? { text } : {}) });
  }
}

function markup(buttons?: Button[][]) {
  if (!buttons) return {};
  return { reply_markup: { inline_keyboard: buttons.map((row) => row.map((b) => ({ text: b.text, callback_data: b.data }))) } };
}
