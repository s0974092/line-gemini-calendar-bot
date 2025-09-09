// Mock external dependencies
const mockReplyMessage = jest.fn();
const mockPushMessage = jest.fn();
jest.mock('@line/bot-sdk', () => ({
  Client: jest.fn(() => ({
    replyMessage: mockReplyMessage,
    pushMessage: mockPushMessage,
  })),
  middleware: jest.fn(() => (req: any, res: any, next: any) => next()),
}));

const mockClassifyIntent = jest.fn();
jest.mock('./services/geminiService', () => ({
  classifyIntent: mockClassifyIntent,
}));

jest.mock('./services/googleCalendarService', () => ({}));

const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisOn = jest.fn(); // <-- THE FIX

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    on: mockRedisOn, // <-- THE FIX
  }));
});

describe('Conversation Timeout Handling', () => {
    let handleEvent: any;
    let consoleLogSpy: jest.SpyInstance;

    beforeEach(() => {
        jest.resetModules();
        // Set the environment variable BEFORE requiring the module
        process.env.USER_WHITELIST = 'expired-user';
        const indexModule = require('./index');
        handleEvent = indexModule.handleEvent;
        consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    });

    afterEach(() => {
        consoleLogSpy.mockRestore();
        jest.clearAllMocks();
    });

    it('should clear expired state and process the message as a new command', async () => {
        const userId = 'expired-user';
        const event = {
            type: 'message',
            replyToken: 'reply-token-expired',
            source: { userId, type: 'user' },
            message: { type: 'text', text: '繼續上次的話題' },
        } as any;

        const expiredTimestamp = Date.now() - (11 * 60 * 1000); // 11 minutes ago
        const expiredState = {
            step: 'awaiting_event_title',
            event: { start: '2025-09-10T15:00:00+08:00' },
            timestamp: expiredTimestamp,
        };

        // The first getConversationState inside handleEvent will get the expired state
        mockRedisGet.mockResolvedValueOnce(JSON.stringify(expiredState))
                    // The second call inside handleTextMessage will get nothing, as it was cleared
                    .mockResolvedValueOnce(undefined);

        mockClassifyIntent.mockResolvedValue({ type: 'incomplete', originalText: '繼續上次的話題' });

        await handleEvent(event);

        expect(mockRedisGet).toHaveBeenCalledWith(userId);
        expect(consoleLogSpy).toHaveBeenCalledWith(`State for user ${userId} has expired.`);
        expect(mockRedisDel).toHaveBeenCalledWith(userId);
        expect(mockClassifyIntent).toHaveBeenCalledWith('繼續上次的話題');
      });
  });
