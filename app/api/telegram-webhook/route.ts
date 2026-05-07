import { timingSafeEqual } from "crypto";
import { after, NextResponse } from "next/server";
import { generateText, stepCountIs, type ToolSet } from "ai";
import { getLanguageModel } from "@/lib/ai/providers";
import { DEFAULT_CHAT_MODEL } from "@/lib/ai/models";
import { Composio } from "@composio/core";
import { VercelProvider } from "@composio/vercel";
import { sendTelegramMessage } from "@/lib/telegram";

export const maxDuration = 300;

interface TelegramMessage {
  message_id: number;
  text?: string;
  chat: { id: number; type: string };
  from?: { id: number; username?: string; first_name?: string };
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

export async function POST(request: Request) {
  const secret = process.env.TELEGRAM_WEBHOOK_SECRET;

  if (!secret) {
    return NextResponse.json({ error: "Telegram not configured" }, { status: 503 });
  }

  // Validate secret token
  const incomingSecret = request.headers.get("x-telegram-bot-api-secret-token") ?? "";
  if (
    incomingSecret.length !== secret.length ||
    !timingSafeEqual(Buffer.from(incomingSecret), Buffer.from(secret))
  ) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  let update: TelegramUpdate;
  try {
    update = (await request.json()) as TelegramUpdate;
  } catch {
    return NextResponse.json({ ok: true });
  }

  const message = update.message;
  if (!message?.text || message.chat.type !== "private") {
    return NextResponse.json({ ok: true });
  }

  const chatId = String(message.chat.id);
  const text = message.text;

  // Respond to Telegram immediately — agent can take 30-120s
  after(runAgent(chatId, text));

  return NextResponse.json({ ok: true });
}

async function runAgent(chatId: string, userMessage: string): Promise<void> {
  try {
    let composioTools: ToolSet = {};

    if (process.env.COMPOSIO_API_KEY) {
      try {
        const composio = new Composio({ provider: new VercelProvider() });
        const session = await composio.create(chatId);
        composioTools = (await session.tools()) as unknown as ToolSet;
      } catch (err) {
        console.error("[telegram] Composio tools failed:", err);
      }
    }

    const result = await generateText({
      model: getLanguageModel(DEFAULT_CHAT_MODEL),
      system: "You are a helpful AI assistant accessible via Telegram. Be concise — responses should be short enough for a chat message.",
      messages: [{ role: "user", content: userMessage }],
      tools: composioTools,
      stopWhen: stepCountIs(5),
    });

    const reply = result.text.trim() || "Done.";
    // Telegram messages max 4096 chars
    await sendTelegramMessage(chatId, reply.slice(0, 4096));
  } catch (err) {
    console.error("[telegram] agent error:", err);
    await sendTelegramMessage(
      chatId,
      "Sorry, something went wrong. Check the server logs."
    ).catch(() => undefined);
  }
}
