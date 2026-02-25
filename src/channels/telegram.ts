import { Bot } from 'grammy';
import telegramifyMarkdown from 'telegramify-markdown';

import { ASSISTANT_NAME, MEDIA_AUTO_DOWNLOAD_MAX_BYTES, TELEGRAM_BOT_TOKEN, TRIGGER_PATTERN } from '../config.js';
import { PendingDownload } from '../db.js';
import { logger } from '../logger.js';
import { buildMediaPath, containerMediaPath, downloadAttachment, formatSize, mediaFileExists } from '../media.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

/**
 * Convert standard Markdown to Telegram MarkdownV2 format.
 * Falls back to plain text (with special chars escaped) if conversion fails.
 */
function toMarkdownV2(text: string): string {
  try {
    return telegramifyMarkdown(text, 'escape');
  } catch (err) {
    logger.warn({ err }, 'telegramify-markdown conversion failed, escaping as plain text');
    // Escape all MarkdownV2 special characters
    return text.replace(/([_*\[\]()~`>#+\-=|{}.!\\])/g, '\\$1');
  }
}

/**
 * Build a Telegram file download URL from a file_path returned by getFile().
 */
function telegramFileUrl(filePath: string): string {
  return `https://api.telegram.org/file/bot${TELEGRAM_BOT_TOKEN}/${filePath}`;
}

export interface TelegramChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  createPendingDownload?: (download: Omit<PendingDownload, 'status' | 'local_path'>) => void;
}

export class TelegramChannel implements Channel {
  name = 'telegram';

  private bot: Bot | null = null;
  private opts: TelegramChannelOpts;
  private botToken: string;

  constructor(botToken: string, opts: TelegramChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.botToken);

    // Command to get chat ID (useful for registration)
    this.bot.command('chatid', (ctx) => {
      const chatId = ctx.chat.id;
      const chatType = ctx.chat.type;
      const chatName =
        chatType === 'private'
          ? ctx.from?.first_name || 'Private'
          : (ctx.chat as any).title || 'Unknown';

      ctx.reply(
        `Chat ID: \`tg:${chatId}\`\nName: ${chatName}\nType: ${chatType}`,
        { parse_mode: 'Markdown' },
      );
    });

    // Command to check bot status
    this.bot.command('ping', (ctx) => {
      ctx.reply(`${ASSISTANT_NAME} is online.`);
    });

    this.bot.on('message:text', async (ctx) => {
      // Skip commands
      if (ctx.message.text.startsWith('/')) return;

      const chatJid = `tg:${ctx.chat.id}`;
      let content = ctx.message.text;
      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id.toString() ||
        'Unknown';
      const sender = ctx.from?.id.toString() || '';
      const msgId = ctx.message.message_id.toString();

      // Determine chat name
      const chatName =
        ctx.chat.type === 'private'
          ? senderName
          : (ctx.chat as any).title || chatJid;

      // Translate Telegram @bot_username mentions into TRIGGER_PATTERN format.
      // Telegram @mentions (e.g., @andy_ai_bot) won't match TRIGGER_PATTERN
      // (e.g., ^@Andy\b), so we prepend the trigger when the bot is @mentioned.
      const botUsername = ctx.me?.username?.toLowerCase();
      if (botUsername) {
        const entities = ctx.message.entities || [];
        const isBotMentioned = entities.some((entity) => {
          if (entity.type === 'mention') {
            const mentionText = content
              .substring(entity.offset, entity.offset + entity.length)
              .toLowerCase();
            return mentionText === `@${botUsername}`;
          }
          return false;
        });
        if (isBotMentioned && !TRIGGER_PATTERN.test(content)) {
          content = `@${ASSISTANT_NAME} ${content}`;
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Telegram chat',
        );
        return;
      }

      // Deliver message — startMessageLoop() will pick it up
      this.opts.onMessage(chatJid, {
        id: msgId,
        chat_jid: chatJid,
        sender,
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });

      logger.info(
        { chatJid, chatName, sender: senderName },
        'Telegram message stored',
      );
    });

    // Helper: store a simple non-downloadable placeholder message
    const storeNonText = (ctx: any, placeholder: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      this.opts.onChatMetadata(chatJid, timestamp);
      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content: `${placeholder}${caption}`,
        timestamp,
        is_from_me: false,
      });
    };

    // Helper: download a Telegram media file (or create a pending download for large/collision files)
    const processMedia = async (
      ctx: any,
      fileId: string,
      filename: string,
      contentType: string,
      size: number | null,
      typeLabel: string,
    ): Promise<string> => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      const groupFolder = group?.folder || chatJid;
      const msgId = ctx.message.message_id.toString();
      const caption = ctx.message.caption ? ` ${ctx.message.caption}` : '';

      const isLarge = size !== null && size >= MEDIA_AUTO_DOWNLOAD_MAX_BYTES;
      const isCollision = mediaFileExists(groupFolder, filename);

      if (isLarge || isCollision) {
        // Need a URL to store — resolve via getFile first
        let downloadUrl: string;
        try {
          const file = await this.bot!.api.getFile(fileId);
          downloadUrl = telegramFileUrl(file.file_path!);
        } catch (err) {
          logger.error({ fileId, err }, 'Failed to get Telegram file path for pending download');
          return `[${typeLabel}: ${filename} — could not resolve download URL]${caption}`;
        }

        const dlId = `dl_${msgId}_${fileId.slice(-8)}`;
        if (this.opts.createPendingDownload) {
          this.opts.createPendingDownload({
            id: dlId,
            chat_jid: chatJid,
            group_folder: groupFolder,
            url: downloadUrl,
            filename,
            content_type: contentType || null,
            size: size ?? 0,
            message_id: msgId,
            created_at: new Date().toISOString(),
          });
        }

        if (isCollision) {
          logger.info({ dlId, filename }, 'Telegram attachment name collision, pending user decision');
          return `[${typeLabel}: ${filename} — a file with this name already exists (pending:${dlId})]${caption}`;
        } else {
          logger.info({ dlId, filename, size: formatSize(size) }, 'Large Telegram attachment pending download approval');
          return `[${typeLabel}: ${filename} — ${formatSize(size)}, not yet downloaded (pending:${dlId})]${caption}`;
        }
      }

      // Download immediately
      try {
        const file = await this.bot!.api.getFile(fileId);
        const downloadUrl = telegramFileUrl(file.file_path!);
        const hostPath = buildMediaPath(groupFolder, filename);
        const agentPath = containerMediaPath(filename);
        await downloadAttachment(downloadUrl, hostPath);
        logger.info({ filename, hostPath }, 'Telegram attachment downloaded');
        return `[${typeLabel}: ${filename} — ${agentPath}]${caption}`;
      } catch (err) {
        logger.error({ filename, err }, 'Failed to download Telegram attachment');
        return `[${typeLabel}: ${filename} — download failed]${caption}`;
      }
    };

    // Helper: store a media message after downloading
    const storeMedia = async (ctx: any, fileId: string, filename: string, contentType: string, size: number | null, typeLabel: string) => {
      const chatJid = `tg:${ctx.chat.id}`;
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) return;

      const timestamp = new Date(ctx.message.date * 1000).toISOString();
      const senderName =
        ctx.from?.first_name ||
        ctx.from?.username ||
        ctx.from?.id?.toString() ||
        'Unknown';

      this.opts.onChatMetadata(chatJid, timestamp);

      const content = await processMedia(ctx, fileId, filename, contentType, size, typeLabel);

      this.opts.onMessage(chatJid, {
        id: ctx.message.message_id.toString(),
        chat_jid: chatJid,
        sender: ctx.from?.id?.toString() || '',
        sender_name: senderName,
        content,
        timestamp,
        is_from_me: false,
      });
    };

    this.bot.on('message:photo', async (ctx) => {
      // Telegram provides multiple sizes — pick the largest
      const photos = ctx.message.photo;
      const photo = photos[photos.length - 1];
      const filename = `photo_${ctx.message.message_id}.jpg`;
      await storeMedia(ctx, photo.file_id, filename, 'image/jpeg', photo.file_size ?? null, 'Photo');
    });

    this.bot.on('message:video', async (ctx) => {
      const video = ctx.message.video;
      const filename = video.file_name || `video_${ctx.message.message_id}.mp4`;
      await storeMedia(ctx, video.file_id, filename, video.mime_type || 'video/mp4', video.file_size ?? null, 'Video');
    });

    this.bot.on('message:voice', async (ctx) => {
      const voice = ctx.message.voice;
      const filename = `voice_${ctx.message.message_id}.ogg`;
      await storeMedia(ctx, voice.file_id, filename, 'audio/ogg', voice.file_size ?? null, 'Voice message');
    });

    this.bot.on('message:audio', async (ctx) => {
      const audio = ctx.message.audio;
      const filename = audio.file_name || `audio_${ctx.message.message_id}.mp3`;
      await storeMedia(ctx, audio.file_id, filename, audio.mime_type || 'audio/mpeg', audio.file_size ?? null, 'Audio');
    });

    this.bot.on('message:document', async (ctx) => {
      const doc = ctx.message.document;
      const filename = doc.file_name || `file_${ctx.message.message_id}`;
      await storeMedia(ctx, doc.file_id, filename, doc.mime_type || 'application/octet-stream', doc.file_size ?? null, 'Document');
    });

    this.bot.on('message:sticker', (ctx) => {
      const emoji = ctx.message.sticker?.emoji || '';
      storeNonText(ctx, `[Sticker ${emoji}]`);
    });
    this.bot.on('message:location', (ctx) => storeNonText(ctx, '[Location]'));
    this.bot.on('message:contact', (ctx) => storeNonText(ctx, '[Contact]'));

    // Handle errors gracefully
    this.bot.catch((err) => {
      logger.error({ err: err.message }, 'Telegram bot error');
    });

    // Start polling — returns a Promise that resolves when started
    return new Promise<void>((resolve) => {
      this.bot!.start({
        onStart: (botInfo) => {
          logger.info(
            { username: botInfo.username, id: botInfo.id },
            'Telegram bot connected',
          );
          console.log(`\n  Telegram bot: @${botInfo.username}`);
          console.log(
            `  Send /chatid to the bot to get a chat's registration ID\n`,
          );
          resolve();
        },
      });
    });
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.bot) {
      logger.warn('Telegram bot not initialized');
      return;
    }

    try {
      const numericId = jid.replace(/^tg:/, '');
      const formatted = toMarkdownV2(text);

      // Telegram has a 4096 character limit per message — split if needed
      const MAX_LENGTH = 4096;
      if (formatted.length <= MAX_LENGTH) {
        await this.bot.api.sendMessage(numericId, formatted, { parse_mode: 'MarkdownV2' });
      } else {
        for (let i = 0; i < formatted.length; i += MAX_LENGTH) {
          await this.bot.api.sendMessage(
            numericId,
            formatted.slice(i, i + MAX_LENGTH),
            { parse_mode: 'MarkdownV2' },
          );
        }
      }
      logger.info({ jid, length: text.length }, 'Telegram message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
    }
  }

  async sendMessageReturningId(jid: string, text: string): Promise<string | null> {
    if (!this.bot) return null;
    try {
      const numericId = jid.replace(/^tg:/, '');
      const formatted = toMarkdownV2(text);
      const msg = await this.bot.api.sendMessage(numericId, formatted, { parse_mode: 'MarkdownV2' });
      return msg.message_id.toString();
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Telegram message');
      return null;
    }
  }

  async editMessage(jid: string, messageId: string, text: string): Promise<boolean> {
    if (!this.bot) return false;
    try {
      const numericId = jid.replace(/^tg:/, '');
      const formatted = toMarkdownV2(text);
      await this.bot.api.editMessageText(numericId, parseInt(messageId, 10), formatted, { parse_mode: 'MarkdownV2' });
      return true;
    } catch (err) {
      logger.warn({ jid, messageId, err }, 'Failed to edit Telegram message');
      return false;
    }
  }

  isConnected(): boolean {
    return this.bot !== null;
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('tg:');
  }

  async disconnect(): Promise<void> {
    if (this.bot) {
      this.bot.stop();
      this.bot = null;
      logger.info('Telegram bot stopped');
    }
  }

}
