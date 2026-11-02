import { TelegramClient } from 'telegram';
import { StringSession } from 'telegram/sessions/index.js';
import type { AppConfig } from '../config.js';

export interface TelegramChannelPost {
  id: number;
  text: string;
  date: Date;
  views?: number | undefined;
  forwards?: number | undefined;
  reactions?: Record<string, number> | undefined;
}

export interface MtProtoService {
  getChannelMessages(channelUsername: string, limit?: number, minId?: number): Promise<TelegramChannelPost[]>;
  getPostStats(channelUsername: string, messageId: number): Promise<{ views: number; forwards: number; reactions: Record<string, number> }>;
  disconnect(): Promise<void>;
}

export class GramJsMtProtoService implements MtProtoService {
  private client: TelegramClient;
  private isConnected = false;

  constructor(
    private apiId: number,
    private apiHash: string,
    private sessionString = '',
  ) {
    const session = new StringSession(this.sessionString);
    this.client = new TelegramClient(session, this.apiId, this.apiHash, {
      connectionRetries: 3,
    });
  }

  private async ensureConnected(): Promise<void> {
    if (!this.isConnected) {
      await this.client.connect();
      this.isConnected = true;
    }
  }

  async getChannelMessages(
    channelUsername: string,
    limit = 20,
    minId = 0,
  ): Promise<TelegramChannelPost[]> {
    await this.ensureConnected();

    try {
      const messages = await this.client.getMessages(channelUsername, {
        limit,
        minId,
      });

      const results: TelegramChannelPost[] = [];
      for (const msg of messages) {
        if (!msg || !msg.message) continue;

        const reactions: Record<string, number> = {};
        if (msg.reactions?.results) {
          for (const r of msg.reactions.results) {
            const emoji = (r.reaction as any)?.emoticon || '👍';
            reactions[emoji] = r.count;
          }
        }

        results.push({
          id: msg.id,
          text: msg.message,
          date: new Date((msg.date || Date.now() / 1000) * 1000),
          views: msg.views,
          forwards: msg.forwards,
          reactions,
        });
      }

      return results;
    } catch (err) {
      console.error(`Error reading messages from ${channelUsername} via MTProto:`, err);
      return [];
    }
  }

  async getPostStats(
    channelUsername: string,
    messageId: number,
  ): Promise<{ views: number; forwards: number; reactions: Record<string, number> }> {
    await this.ensureConnected();

    try {
      const msgs = await this.client.getMessages(channelUsername, {
        ids: [messageId],
      });
      const msg = msgs[0];
      if (!msg) {
        return { views: 0, forwards: 0, reactions: {} };
      }

      const reactions: Record<string, number> = {};
      if (msg.reactions?.results) {
        for (const r of msg.reactions.results) {
          const emoji = (r.reaction as any)?.emoticon || '👍';
          reactions[emoji] = r.count;
        }
      }

      return {
        views: msg.views || 0,
        forwards: msg.forwards || 0,
        reactions,
      };
    } catch (err) {
      console.error(`Error getting post stats for ${channelUsername}:${messageId}:`, err);
      return { views: 0, forwards: 0, reactions: {} };
    }
  }

  async disconnect(): Promise<void> {
    if (this.isConnected) {
      await this.client.disconnect();
      this.isConnected = false;
    }
  }
}

/**
 * Mock MTProto сервис для тестов и сред без настроенной GramJS сессии
 */
export class MockMtProtoService implements MtProtoService {
  async getChannelMessages(): Promise<TelegramChannelPost[]> {
    return [];
  }

  async getPostStats(): Promise<{ views: number; forwards: number; reactions: Record<string, number> }> {
    return {
      views: 150,
      forwards: 5,
      reactions: { '🔥': 12, '👍': 25, '😴': 2 },
    };
  }

  async disconnect(): Promise<void> {
    // ничего не делаем
  }
}

export function createMtProtoService(config: AppConfig): MtProtoService {
  if (config.tgApiId && config.tgApiHash) {
    return new GramJsMtProtoService(config.tgApiId, config.tgApiHash, config.tgSession ?? '');
  }
  // Молчаливый mock в проде опасен: сервис пишет фиктивные метрики (views/forwards),
  // которые потом «подтверждают» решения Analyst. Громко предупреждаем.
  console.error(
    '[MTProto] TG_API_ID/TG_API_HASH не заданы — работает MockMtProtoService: ' +
      'метрики постов будут фиктивными! Для реальных данных задай TG_API_ID, TG_API_HASH, TG_SESSION.',
  );
  return new MockMtProtoService();
}
