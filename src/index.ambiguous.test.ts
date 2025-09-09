import { TextMessage, TemplateMessage } from '@line/bot-sdk';

// Mock external dependencies
const mockReplyMessage = jest.fn();
jest.mock('@line/bot-sdk', () => ({
  Client: jest.fn(() => ({
    replyMessage: mockReplyMessage,
  })),
  middleware: jest.fn(() => (req: any, res: any, next: any) => next()),
}));

const mockClassifyIntent = jest.fn();
jest.mock('./services/geminiService', () => ({
  classifyIntent: mockClassifyIntent,
}));

const mockGetCalendarChoicesForUser = jest.fn();
const mockSearchEvents = jest.fn();
jest.mock('./services/googleCalendarService', () => ({
  getCalendarChoicesForUser: mockGetCalendarChoicesForUser,
  searchEvents: mockSearchEvents,
}));

const mockRedisSet = jest.fn();
const mockRedisOn = jest.fn(); // <-- THE FIX

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    set: mockRedisSet,
    on: mockRedisOn, // <-- THE FIX
  }));
});

describe('Ambiguous Intent Handling', () => {
    let handleNewCommand: any;
    const replyToken = 'test-reply-token';
    const userId = 'test-user';

    beforeEach(() => {
        jest.resetModules();
        process.env.USER_WHITELIST = userId;
        const indexModule = require('./index');
        handleNewCommand = indexModule.handleNewCommand;
    });

    afterEach(() => {
        jest.clearAllMocks();
    });

    it('should ask for clarification when multiple events match an update request', async () => {
      const intent = {
        type: 'update_event',
        timeMin: '2025-01-01T00:00:00+08:00',
        timeMax: '2025-01-01T23:59:59+08:00',
        query: '會議',
        changes: {},
      };
      const message = { type: 'text', text: '修改明天的會議' } as any;
      const multipleEvents = [
        { id: 'event1', summary: '會議 1', start: { dateTime: '2025-01-01T10:00:00+08:00' }, end: { dateTime: '2025-01-01T11:00:00+08:00' }, organizer: { email: 'primary' }, htmlLink: 'http://go.co/event1' },
        { id: 'event2', summary: '會議 2', start: { dateTime: '2025-01-01T14:00:00+08:00' }, end: { dateTime: '2025-01-01T15:00:00+08:00' }, organizer: { email: 'primary' }, htmlLink: 'http://go.co/event2' },
      ];

      mockClassifyIntent.mockResolvedValue(intent);
      mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
      mockSearchEvents.mockResolvedValue({ events: multipleEvents });

      await handleNewCommand(replyToken, message, userId);

      expect(mockSearchEvents).toHaveBeenCalled();
      const reply = mockReplyMessage.mock.calls[0][1];
      expect(reply[0].text).toBe('我找到了多個符合條件的活動，請選擇您想修改的是哪一個？');
      expect(reply[1].template.type).toBe('carousel');
      expect(reply[1].template.columns.length).toBe(2);
      expect(reply[1].template.columns[0].title).toBe('會議 1');
    });

    it('should ask for clarification when multiple events match a delete request', async () => {
        const intent = {
          type: 'delete_event',
          timeMin: '2025-01-01T00:00:00+08:00',
          timeMax: '2025-01-01T23:59:59+08:00',
          query: '會議',
        };
        const message = { type: 'text', text: '刪除明天的會議' } as any;
        const multipleEvents = [{ id: 'event1' }, { id: 'event2' }];
  
        mockClassifyIntent.mockResolvedValue(intent);
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockSearchEvents.mockResolvedValue({ events: multipleEvents });
  
        await handleNewCommand(replyToken, message, userId);
  
        expect(mockSearchEvents).toHaveBeenCalled();
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, {
          type: 'text',
          text: '我找到了多個符合條件的活動，請您先用「查詢」功能找到想刪除的活動，然後再點擊該活動下方的「刪除」按鈕。'
        });
      });
  });
