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
});