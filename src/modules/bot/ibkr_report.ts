import type { NextFunction } from "grammy";
import { logUserError, replyUserError } from "./errors.ts";
import type { CustomContext } from "./types.ts";

export async function withIbkrReportRecovery(ctx: CustomContext, next: NextFunction) {
  if (!ctx.from || !ctx.msg) return await next();

  let parentId = ctx.msg.message_id;
  const topicId = ctx.msg.is_topic_message ? ctx.msg.message_thread_id : undefined;
  const options = () => ({
    ...(topicId === undefined ? {} : { message_thread_id: topicId }),
    reply_parameters: { message_id: parentId, allow_sending_without_reply: true },
  });
  const firstReply = Promise.withResolvers<void>();
  let pending = Promise.resolve();
  let waiting = false;
  let finished = false;
  const gateways = new Map<string, string>();

  ctx.ibkrReportRecovery = {
    userId: ctx.from.id,
    onProgress(host, message) {
      if (finished || gateways.get(host) === message) return;
      gateways.set(host, message);
      const text = gateways.size > 1 ? `${host} · ${message}` : message;
      pending = pending.then(async () => {
        const reply = await ctx.reply(text, options());
        parentId = reply.message_id;
      }).catch((error) => logUserError(ctx, error));
      if (!waiting) {
        waiting = true;
        firstReply.resolve(pending);
      }
    },
    async replyOptions() {
      if (!waiting) return undefined;
      await pending;
      return options();
    },
  };

  // The original handler continues after recovery while the runner takes other updates.
  const command = next().catch(async (error) => {
    if (!waiting) throw error;
    try {
      await replyUserError(ctx, error);
    } catch (deliveryError) {
      logUserError(ctx, deliveryError);
    }
  }).finally(() => { finished = true; });
  await Promise.race([command, firstReply.promise]);
}
