const E2E_CHAT_ID = 555555555;
export const E2E_CHAT = { id: E2E_CHAT_ID };

interface UpdateOptions {
  chatId?: number;
  photo?: { fileId: string; caption?: string };
  callbackData?: string;
}

interface UpdateResult {
  status: number;
  reply: string | undefined;
  captures: Array<{ chatId: number | string; text: string; payload?: any }>;
  data: any;
}

/**
 * Post a synthetic Telegram Update to the bot webhook. Requires
 * E2E_TELEGRAM_CAPTURE=1 to be set on the server (the workflow sets it).
 */
export async function postUpdate(
  text: string,
  options: UpdateOptions = {}
): Promise<UpdateResult> {
  const baseURL = process.env.E2E_BASE_URL || 'https://agentbook.brainliber.com';
  const chatId = options.chatId ?? E2E_CHAT_ID;

  const update: any = {
    update_id: Math.floor(Math.random() * 1e9),
    message: {
      message_id: Math.floor(Math.random() * 1e9),
      date: Math.floor(Date.now() / 1000),
      chat: { id: chatId, type: 'private' },
      from: { id: chatId, is_bot: false, first_name: 'E2E' },
    },
  };

  if (options.photo) {
    update.message.photo = [{ file_id: options.photo.fileId, file_size: 1000, width: 100, height: 100 }];
    if (options.photo.caption) update.message.caption = options.photo.caption;
  } else {
    update.message.text = text;
  }

  if (options.callbackData) {
    update.callback_query = {
      id: String(Math.random()),
      from: { id: chatId, is_bot: false, first_name: 'E2E' },
      data: options.callbackData,
      message: { message_id: 0, chat: { id: chatId, type: 'private' } },
    };
  }

  // Prove we are the suite. The webhook used to accept ANY unauthenticated
  // POST whenever E2E_TELEGRAM_CAPTURE was set on the server, so turning these
  // tests on turned the security gate off. It now requires this token — which
  // means an unset E2E_RESET_TOKEN must fail loudly here, not run the phase
  // against what would otherwise look like a working endpoint.
  const e2eToken = process.env.E2E_RESET_TOKEN;
  if (!e2eToken) {
    throw new Error(
      'E2E_RESET_TOKEN is unset, so the webhook will reject these synthetic Updates with 401. ' +
      'That is the gate working: the token is how the suite identifies itself now that capture ' +
      'no longer disables the Telegram secret check.',
    );
  }

  const res = await fetch(`${baseURL}/api/v1/agentbook/telegram/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-e2e-token': e2eToken },
    body: JSON.stringify(update),
  });

  let data: any = {};
  try { data = await res.json(); } catch { /* */ }

  return {
    status: res.status,
    reply: data?.botReply,
    captures: data?.captured || [],
    data,
  };
}
