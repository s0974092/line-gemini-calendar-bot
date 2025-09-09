import { FileEventMessage, PostbackEvent } from '@line/bot-sdk';
import { CalendarEvent } from './services/geminiService';

// Mock external dependencies
const mockReplyMessage = jest.fn();
const mockPushMessage = jest.fn();
const mockGetMessageContent = jest.fn();

jest.mock('@line/bot-sdk', () => ({
  Client: jest.fn(() => ({
    replyMessage: mockReplyMessage,
    pushMessage: mockPushMessage,
    getMessageContent: mockGetMessageContent,
  })),
  middleware: jest.fn(() => (req: any, res: any, next: () => any) => next()),
}));

const mockClassifyIntent = jest.fn();
const mockParseRecurrenceEndCondition = jest.fn();
const mockParseEventChanges = jest.fn();

jest.mock('./services/geminiService', () => ({
  classifyIntent: mockClassifyIntent,
  parseRecurrenceEndCondition: mockParseRecurrenceEndCondition,
  parseEventChanges: mockParseEventChanges,
}));

const mockCreateCalendarEvent = jest.fn();
const mockGetCalendarChoicesForUser = jest.fn();
const mockDeleteEvent = jest.fn();
const mockCalendarEventsGet = jest.fn();
const mockCalendarEventsList = jest.fn();
const mockFindEventsInTimeRange = jest.fn();
const mockSearchEvents = jest.fn();
const mockUpdateEvent = jest.fn();

jest.mock('./services/googleCalendarService', () => ({
  createCalendarEvent: mockCreateCalendarEvent,
  getCalendarChoicesForUser: mockGetCalendarChoicesForUser,
  deleteEvent: mockDeleteEvent,
  findEventsInTimeRange: mockFindEventsInTimeRange,
  searchEvents: mockSearchEvents,
  updateEvent: mockUpdateEvent,
  calendar: {
    events: {
      get: mockCalendarEventsGet,
      list: mockCalendarEventsList,
    },
  },
  DuplicateEventError: class extends Error {
    public htmlLink?: string | null;
    constructor(message: string, htmlLink?: string | null) {
      super(message);
      this.name = 'DuplicateEventError';
      this.htmlLink = htmlLink;
    }
  },
}));

// Since the main module now uses Redis, we mock the Redis functions for testing
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisOn = jest.fn();
jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    on: mockRedisOn,
    quit: jest.fn((callback) => callback()),
  }));
});


describe('index.ts unit tests', () => {
  afterAll((done) => {
    const indexModule = require('./index');
    if (indexModule.server) {
      indexModule.server.close(() => {
        indexModule.redis.quit(done);
      });
    } else {
      indexModule.redis.quit(done);
    }
  });

  afterEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
  });

  describe('Redis Error Handling', () => {
    it('should log an error when redis connection fails', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      mockRedisOn.mockImplementation((event, callback) => {
        if (event === 'error') {
          callback(new Error('Redis connection failed'));
        }
      });
      require('./index');
      expect(mockRedisOn).toHaveBeenCalledWith('error', expect.any(Function));
      expect(consoleErrorSpy).toHaveBeenCalledWith('Redis Error:', expect.any(Error));
      consoleErrorSpy.mockRestore();
    });
  });

  describe('Ambiguous Intent Handling', () => {
    let handleNewCommand: any;
    const replyToken = 'test-reply-token';
    const userId = 'test-user';

    beforeEach(() => {
        jest.resetModules();
        const indexModule = require('./index');
        handleNewCommand = indexModule.handleNewCommand;
        process.env.USER_WHITELIST = userId;
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
      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, [
        { type: 'text', text: '我找到了多個符合條件的活動，請選擇您想修改的是哪一個？' },
        {
            type: 'template',
            altText: '請選擇要修改的活動',
            template: {
                type: 'carousel',
                columns: [
                    {
                        title: '會議 1',
                        text: '標題：會議 1\n時間：2025/01/01 10:00 - 11:00',
                        actions: [
                            { type: 'postback', label: '修改活動', data: 'action=modify&eventId=event1&calendarId=primary' },
                            { type: 'uri', label: '在日曆中查看', uri: 'http://go.co/event1' },
                        ]
                    },
                    {
                        title: '會議 2',
                        text: '標題：會議 2\n時間：2025/01/01 14:00 - 15:00',
                        actions: [
                            { type: 'postback', label: '修改活動', data: 'action=modify&eventId=event2&calendarId=primary' },
                            { type: 'uri', label: '在日曆中查看', uri: 'http://go.co/event2' },
                        ]
                    }
                ]
            }
        }
      ]);
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

  describe('Multi-turn Conversation Scenarios', () => {
    let handleTextMessage: any;
  
    beforeEach(() => {
      jest.resetModules();
      const indexModule = require('./index');
      handleTextMessage = indexModule.handleTextMessage;
      process.env.USER_WHITELIST = 'multi-turn-user'; // Whitelist user for these tests
    });
  
    it('should handle multi-turn event creation: time first, then title', async () => {
      const userId = 'multi-turn-user';
      const partialEvent = {
        title: null,
        start: '2025-09-10T15:00:00+08:00',
        end: '2025-09-10T16:00:00+08:00',
      };
  
      // --- Turn 1: User sends time only ---
      const replyToken1 = 'reply-token-1';
      const firstMessage = { type: 'text', text: '明天下午三點' };
      mockClassifyIntent.mockResolvedValue({ type: 'create_event', event: partialEvent });
      mockRedisGet.mockResolvedValue(undefined); // No initial state
  
      await handleTextMessage(replyToken1, firstMessage, userId);
  
      // Assertions for Turn 1
      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken1, {
        type: 'text',
        text: expect.stringContaining('要安排什麼活動呢？'),
      });
      expect(mockRedisSet).toHaveBeenCalledWith(userId, expect.any(String), 'EX', 3600);
      const stateSet = JSON.parse(mockRedisSet.mock.calls[0][1]);
      expect(stateSet.step).toBe('awaiting_event_title');
  
      // --- Turn 2: User sends the title ---
      const replyToken2 = 'reply-token-2';
      const secondMessage = { type: 'text', text: '跟客戶開會' };
      mockRedisGet.mockResolvedValue(JSON.stringify(stateSet)); // Provide the state from Turn 1
      mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
      mockFindEventsInTimeRange.mockResolvedValue([]); // No conflicts
      const createdEvent = { htmlLink: 'http://example.com/new-event', organizer: { email: 'primary' }, summary: '跟客戶開會', start: { dateTime: partialEvent.start }, end: { dateTime: partialEvent.end } };
      mockCreateCalendarEvent.mockResolvedValue(createdEvent);
      mockCalendarEventsList.mockResolvedValue({ data: { items: [createdEvent] } });
  
      await handleTextMessage(replyToken2, secondMessage, userId);
  
      // Assertions for Turn 2
      expect(mockCreateCalendarEvent).toHaveBeenCalledWith(expect.objectContaining({ title: '跟客戶開會' }), 'primary');
      expect(mockRedisDel).toHaveBeenCalledWith(userId);
      expect(mockPushMessage).toHaveBeenCalledWith(userId, expect.any(Object));
    });

    it('should handle multi-turn: recurring event first, then end condition', async () => {
        const userId = 'multi-turn-user';
        const initialEvent = {
            title: '每週站會',
            start: '2025-09-15T09:00:00+08:00',
            end: '2025-09-15T09:30:00+08:00',
            recurrence: 'RRULE:FREQ=WEEKLY;BYDAY=MO',
        };

        // --- Turn 1: User sends recurring event info ---
        const replyToken1 = 'reply-token-recur-1';
        const firstMessage = { type: 'text', text: '每週一早上九點的站立會議' };
        mockClassifyIntent.mockResolvedValue({ type: 'create_event', event: initialEvent });
        mockRedisGet.mockResolvedValue(undefined);

        await handleTextMessage(replyToken1, firstMessage, userId);

        // Assertions for Turn 1
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken1, {
            type: 'text',
            text: expect.stringContaining('請問您希望它什麼時候結束？'),
        });
        expect(mockRedisSet).toHaveBeenCalledWith(userId, expect.any(String), 'EX', 3600);
        const stateSet = JSON.parse(mockRedisSet.mock.calls[0][1]);
        expect(stateSet.step).toBe('awaiting_recurrence_end_condition');
        expect(stateSet.event).toEqual(initialEvent);

        // --- Turn 2: User provides end condition ---
        const replyToken2 = 'reply-token-recur-2';
        const secondMessage = { type: 'text', text: '重複十次' };
        const updatedRrule = 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10';
        mockRedisGet.mockResolvedValue(JSON.stringify(stateSet));
        mockParseRecurrenceEndCondition.mockResolvedValue({ updatedRrule });

        // Mocks for final creation
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockFindEventsInTimeRange.mockResolvedValue([]);
        const createdEvent = { htmlLink: 'http://example.com/recurring-event' };
        mockCreateCalendarEvent.mockResolvedValue(createdEvent);
        mockCalendarEventsList.mockResolvedValue({ data: { items: [] } });

        await handleTextMessage(replyToken2, secondMessage, userId);

        // Assertions for Turn 2
        expect(mockParseRecurrenceEndCondition).toHaveBeenCalledWith('重複十次', initialEvent.recurrence, initialEvent.start);
        expect(mockCreateCalendarEvent).toHaveBeenCalledWith(
            expect.objectContaining({ recurrence: updatedRrule }),
            'primary'
        );
        expect(mockRedisDel).toHaveBeenCalledWith(userId);
    });
  });
});