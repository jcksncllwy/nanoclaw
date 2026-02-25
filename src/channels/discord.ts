import { Attachment, Client, Collection, Events, GatewayIntentBits, Message, TextChannel, ThreadChannel } from 'discord.js';

import { ASSISTANT_NAME, MEDIA_AUTO_DOWNLOAD_MAX_BYTES, TRIGGER_PATTERN } from '../config.js';
import { PendingDownload } from '../db.js';
import { logger } from '../logger.js';
import { buildMediaPath, containerMediaPath, downloadAttachment, formatSize, mediaFileExists } from '../media.js';
import {
  Channel,
  OnChatMetadata,
  OnInboundMessage,
  RegisteredGroup,
} from '../types.js';

export interface DiscordChannelOpts {
  onMessage: OnInboundMessage;
  onChatMetadata: OnChatMetadata;
  registeredGroups: () => Record<string, RegisteredGroup>;
  getLastMessageId?: (chatJid: string) => string | null;
  createPendingDownload?: (download: Omit<PendingDownload, 'status' | 'local_path'>) => void;
}

export class DiscordChannel implements Channel {
  name = 'discord';

  private client: Client | null = null;
  private opts: DiscordChannelOpts;
  private botToken: string;
  private hasConnectedOnce = false;

  constructor(botToken: string, opts: DiscordChannelOpts) {
    this.botToken = botToken;
    this.opts = opts;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
    });

    this.client.on(Events.MessageCreate, async (message: Message) => {
      // Ignore bot messages (including own)
      if (message.author.bot) return;

      const channelId = message.channelId;
      const chatJid = `dc:${channelId}`;
      let content = message.content;
      const timestamp = message.createdAt.toISOString();
      const senderName =
        message.member?.displayName ||
        message.author.displayName ||
        message.author.username;
      const sender = message.author.id;
      const msgId = message.id;

      // Determine chat name
      let chatName: string;
      if (message.guild) {
        const textChannel = message.channel as TextChannel;
        chatName = `${message.guild.name} #${textChannel.name}`;
      } else {
        chatName = senderName;
      }

      // Translate Discord @bot mentions into TRIGGER_PATTERN format.
      // Discord mentions look like <@botUserId> — these won't match
      // TRIGGER_PATTERN (e.g., ^@Andy\b), so we prepend the trigger
      // when the bot is @mentioned.
      if (this.client?.user) {
        const botId = this.client.user.id;
        const isBotMentioned =
          message.mentions.users.has(botId) ||
          content.includes(`<@${botId}>`) ||
          content.includes(`<@!${botId}>`);

        if (isBotMentioned) {
          // Strip the <@botId> mention to avoid visual clutter
          content = content
            .replace(new RegExp(`<@!?${botId}>`, 'g'), '')
            .trim();
          // Prepend trigger if not already present
          if (!TRIGGER_PATTERN.test(content)) {
            content = `@${ASSISTANT_NAME} ${content}`;
          }
        }
      }

      // Handle attachments — download files and include local paths
      if (message.attachments.size > 0) {
        const group = this.opts.registeredGroups()[chatJid];
        const attachmentDescriptions = await this.processAttachments(
          message.attachments,
          group?.folder || chatJid,
          msgId,
          chatJid,
        );
        if (content) {
          content = `${content}\n${attachmentDescriptions.join('\n')}`;
        } else {
          content = attachmentDescriptions.join('\n');
        }
      }

      // Handle reply context — include who the user is replying to
      if (message.reference?.messageId) {
        try {
          const repliedTo = await message.channel.messages.fetch(
            message.reference.messageId,
          );
          const replyAuthor =
            repliedTo.member?.displayName ||
            repliedTo.author.displayName ||
            repliedTo.author.username;
          content = `[Reply to ${replyAuthor}] ${content}`;
        } catch {
          // Referenced message may have been deleted
        }
      }

      // Store chat metadata for discovery
      this.opts.onChatMetadata(chatJid, timestamp, chatName);

      // Only deliver full message for registered groups
      const group = this.opts.registeredGroups()[chatJid];
      if (!group) {
        logger.debug(
          { chatJid, chatName },
          'Message from unregistered Discord channel',
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
        'Discord message stored',
      );
    });

    // Handle errors gracefully
    this.client.on(Events.Error, (err) => {
      logger.error({ err: err.message }, 'Discord client error');
    });

    return new Promise<void>((resolve) => {
      this.client!.on(Events.ClientReady, (readyClient) => {
        if (!this.hasConnectedOnce) {
          this.hasConnectedOnce = true;
          logger.info(
            { username: readyClient.user.tag, id: readyClient.user.id },
            'Discord bot connected',
          );
          console.log(`\n  Discord bot: ${readyClient.user.tag}`);
          console.log(
            `  Use /chatid command or check channel IDs in Discord settings\n`,
          );
          resolve();
        } else {
          logger.info('Discord bot reconnected (full reconnect)');
          this.recoverMissedMessages();
        }
      });

      this.client!.on(Events.ShardResume, () => {
        logger.info('Discord shard resumed');
        this.recoverMissedMessages();
      });

      this.client!.login(this.botToken);
    });
  }

  private async processAttachments(
    attachments: Collection<string, Attachment>,
    groupFolder: string,
    messageId: string,
    chatJid: string,
  ): Promise<string[]> {
    const descriptions: string[] = [];

    for (const att of attachments.values()) {
      const contentType = att.contentType || '';
      const name = att.name || 'file';
      let typeLabel: string;
      if (contentType.startsWith('image/')) typeLabel = 'Image';
      else if (contentType.startsWith('video/')) typeLabel = 'Video';
      else if (contentType.startsWith('audio/')) typeLabel = 'Audio';
      else typeLabel = 'File';

      const size = att.size;

      // Large file or name collision — create pending download for agent to handle
      const needsPending = size >= MEDIA_AUTO_DOWNLOAD_MAX_BYTES || mediaFileExists(groupFolder, name);
      if (needsPending) {
        const dlId = `dl_${messageId}_${att.id}`;
        const isCollision = mediaFileExists(groupFolder, name);
        if (this.opts.createPendingDownload) {
          this.opts.createPendingDownload({
            id: dlId,
            chat_jid: chatJid,
            group_folder: groupFolder,
            url: att.url,
            filename: name,
            content_type: contentType || null,
            size,
            message_id: messageId,
            created_at: new Date().toISOString(),
          });
        }
        if (isCollision) {
          logger.info({ dlId, name }, 'Attachment name collision, pending user decision');
          descriptions.push(`[${typeLabel}: ${name} — a file with this name already exists (pending:${dlId})]`);
        } else {
          logger.info({ dlId, name, size: formatSize(size) }, 'Large attachment pending download approval');
          descriptions.push(`[${typeLabel}: ${name} — ${formatSize(size)}, not yet downloaded (pending:${dlId})]`);
        }
        continue;
      }

      // Download immediately
      const hostPath = buildMediaPath(groupFolder, name);
      const agentPath = containerMediaPath(name);
      try {
        await downloadAttachment(att.url, hostPath);
        descriptions.push(`[${typeLabel}: ${name} — ${agentPath}]`);
      } catch (err) {
        logger.error({ name, err }, 'Failed to download Discord attachment');
        descriptions.push(`[${typeLabel}: ${name} — download failed]`);
      }
    }

    return descriptions;
  }

  private async recoverMissedMessages(): Promise<void> {
    if (!this.client || !this.opts.getLastMessageId) return;

    const groups = this.opts.registeredGroups();
    for (const [chatJid, group] of Object.entries(groups)) {
      if (!chatJid.startsWith('dc:')) continue;

      const lastMessageId = this.opts.getLastMessageId(chatJid);
      if (!lastMessageId) {
        logger.debug({ chatJid }, 'No previous messages in DB, skipping recovery');
        continue;
      }

      try {
        const channelId = chatJid.replace(/^dc:/, '');
        const channel = await this.client.channels.fetch(channelId);
        if (!channel || !('messages' in channel)) continue;

        const textChannel = channel as TextChannel;
        const messages = await textChannel.messages.fetch({ after: lastMessageId, limit: 100 });

        // Filter bot messages and sort oldest-first
        const userMessages = [...messages.values()]
          .filter((m) => !m.author.bot)
          .sort((a, b) => a.createdTimestamp - b.createdTimestamp);

        if (userMessages.length === 0) continue;

        logger.info(
          { chatJid, groupName: group.name, count: userMessages.length },
          'Recovering missed messages after reconnect',
        );

        for (const message of userMessages) {
          let content = message.content;
          const timestamp = message.createdAt.toISOString();
          const senderName =
            message.member?.displayName ||
            message.author.displayName ||
            message.author.username;
          const sender = message.author.id;

          // Translate @bot mentions (same as live handler)
          if (this.client?.user) {
            const botId = this.client.user.id;
            const isBotMentioned =
              message.mentions.users.has(botId) ||
              content.includes(`<@${botId}>`) ||
              content.includes(`<@!${botId}>`);
            if (isBotMentioned) {
              content = content.replace(new RegExp(`<@!?${botId}>`, 'g'), '').trim();
              if (!TRIGGER_PATTERN.test(content)) {
                content = `@${ASSISTANT_NAME} ${content}`;
              }
            }
          }

          // Handle attachments
          if (message.attachments.size > 0) {
            const attachmentDescriptions = await this.processAttachments(
              message.attachments,
              group.folder,
              message.id,
              chatJid,
            );
            content = content
              ? `${content}\n${attachmentDescriptions.join('\n')}`
              : attachmentDescriptions.join('\n');
          }

          this.opts.onChatMetadata(chatJid, timestamp, group.name);
          this.opts.onMessage(chatJid, {
            id: message.id,
            chat_jid: chatJid,
            sender,
            sender_name: senderName,
            content,
            timestamp,
            is_from_me: false,
          });
        }
      } catch (err) {
        logger.error({ chatJid, err }, 'Failed to recover missed messages');
      }
    }
  }

  async sendMessage(jid: string, text: string): Promise<void> {
    if (!this.client) {
      logger.warn('Discord client not initialized');
      return;
    }

    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);

      if (!channel || !('send' in channel)) {
        logger.warn({ jid }, 'Discord channel not found or not text-based');
        return;
      }

      const textChannel = channel as TextChannel;

      // Discord has a 2000 character limit per message — split if needed
      const MAX_LENGTH = 2000;
      if (text.length <= MAX_LENGTH) {
        await textChannel.send(text);
      } else {
        for (let i = 0; i < text.length; i += MAX_LENGTH) {
          await textChannel.send(text.slice(i, i + MAX_LENGTH));
        }
      }
      logger.info({ jid, length: text.length }, 'Discord message sent');
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message');
    }
  }

  isConnected(): boolean {
    return this.client !== null && this.client.isReady();
  }

  ownsJid(jid: string): boolean {
    return jid.startsWith('dc:');
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.destroy();
      this.client = null;
      logger.info('Discord bot stopped');
    }
  }

  async sendMessageReturningId(jid: string, text: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('send' in channel)) return null;
      const msg = await (channel as TextChannel).send(text);
      return msg.id;
    } catch (err) {
      logger.error({ jid, err }, 'Failed to send Discord message for thread');
      return null;
    }
  }

  async editMessage(jid: string, messageId: string, text: string): Promise<boolean> {
    if (!this.client) return false;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return false;
      const textChannel = channel as TextChannel;
      const message = await textChannel.messages.fetch(messageId);
      await message.edit(text);
      return true;
    } catch (err) {
      logger.debug({ jid, messageId, err }, 'Failed to edit Discord message');
      return false;
    }
  }

  async startThread(jid: string, messageId: string, name: string): Promise<string | null> {
    if (!this.client) return null;
    try {
      const channelId = jid.replace(/^dc:/, '');
      const channel = await this.client.channels.fetch(channelId);
      if (!channel || !('messages' in channel)) return null;
      const textChannel = channel as TextChannel;
      const message = await textChannel.messages.fetch(messageId);
      const thread = await message.startThread({ name });
      return thread.id;
    } catch (err) {
      logger.error({ jid, messageId, err }, 'Failed to create Discord thread');
      return null;
    }
  }

  async sendThreadMessage(threadId: string, text: string): Promise<void> {
    if (!this.client) return;
    try {
      const thread = await this.client.channels.fetch(threadId);
      if (thread && 'send' in thread) {
        const threadChannel = thread as ThreadChannel;
        const MAX_LENGTH = 2000;
        if (text.length <= MAX_LENGTH) {
          await threadChannel.send(text);
        } else {
          for (let i = 0; i < text.length; i += MAX_LENGTH) {
            await threadChannel.send(text.slice(i, i + MAX_LENGTH));
          }
        }
      }
    } catch (err) {
      logger.debug({ threadId, err }, 'Failed to send Discord thread message');
    }
  }

  async createEmoji(guildId: string, name: string, imageUrl: string): Promise<string> {
    if (!this.client) throw new Error('Discord client not initialized');
    const guild = await this.client.guilds.fetch(guildId);
    const emoji = await guild.emojis.create({ attachment: imageUrl, name });
    return emoji.id;
  }

  getGuildId(jid: string): string | null {
    if (!this.client) return null;
    const channelId = jid.replace(/^dc:/, '');
    // Look up guild from cached channels
    const channel = this.client.channels.cache.get(channelId);
    if (channel && 'guild' in channel) {
      return (channel as TextChannel).guild.id;
    }
    return null;
  }
}
