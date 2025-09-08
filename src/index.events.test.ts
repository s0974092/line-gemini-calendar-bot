import { WebhookEvent } from '@line/bot-sdk';

const mockReplyMessage = jest.fn();
const mockPushMessage = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisOn = jest.fn();
const mockRedisQuit = jest.fn();

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    on: mockRedisOn,
    quit: mockRedisQuit,
  }));
});

jest.mock('@line/bot-sdk', () => ({
  Client: jest.fn(() => ({
    replyMessage: mockReplyMessage,
    pushMessage: mockPushMessage,
  })),
  middleware: jest.fn(() => (req: any, res: any, next: () => any) => next()),
}));

describe('index.ts event handling tests', () => {
    const userId = 'testUser';

    beforeEach(() => {
        jest.resetModules();
        jest.clearAllMocks();
        process.env.LINE_CHANNEL_SECRET = 'test_secret';
        process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
        process.env.USER_WHITELIST = 'testUser';
    });

    it('should do nothing for unhandled event types', async () => {
        const { handleEvent, redis } = require('./index');
        const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const event = { type: 'unfollow', source: { userId } } as any;
        await handleEvent(event);
        expect(consoleLogSpy).toHaveBeenCalledWith('Unhandled event type: unfollow');
        consoleLogSpy.mockRestore();
        if (redis) {
            await redis.quit();
        }
    });

    it('should do nothing for unhandled message types like sticker', async () => {
        const { handleEvent, redis } = require('./index');
        
        const event: WebhookEvent = {
            type: 'message',
            replyToken: 'testReplyToken',
            source: { type: 'user', userId },
            timestamp: Date.now(),
            mode: 'active',
            webhookEventId: 'test-webhook-id',
            deliveryContext: { isRedelivery: false },
            message: {
                type: 'sticker',
                id: '12345',
                packageId: '1',
                stickerId: '1',
                stickerResourceType: 'STATIC',
                keywords: [],
                quoteToken: 'test-quote-token',
            },
        };

        const result = await handleEvent(event);

        expect(result).toBeNull();
        expect(mockReplyMessage).not.toHaveBeenCalled();
        expect(mockPushMessage).not.toHaveBeenCalled();
        
        if (redis) {
            await redis.quit();
        }
    });
});