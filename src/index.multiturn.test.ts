import { CalendarEvent } from './services/geminiService';

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
const mockParseRecurrenceEndCondition = jest.fn();
jest.mock('./services/geminiService', () => ({
  classifyIntent: mockClassifyIntent,
  parseRecurrenceEndCondition: mockParseRecurrenceEndCondition,
}));

const mockCreateCalendarEvent = jest.fn();
const mockGetCalendarChoicesForUser = jest.fn();
const mockFindEventsInTimeRange = jest.fn();
const mockCalendarEventsList = jest.fn();
jest.mock('./services/googleCalendarService', () => ({
  createCalendarEvent: mockCreateCalendarEvent,
  getCalendarChoicesForUser: mockGetCalendarChoicesForUser,
  findEventsInTimeRange: mockFindEventsInTimeRange,
  calendar: {
    events: {
      list: mockCalendarEventsList,
    },
  },
}));

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

describe('Multi-turn Conversation Scenarios', () => {
    let handleTextMessage: any;
  
    beforeEach(() => {
      jest.resetModules();
      const indexModule = require('./index');
      handleTextMessage = indexModule.handleTextMessage;
      process.env.USER_WHITELIST = 'multi-turn-user'; // Whitelist user for these tests
    });
  
    afterEach(() => {
      jest.clearAllMocks();
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
      const firstMessage = { type: 'text', text: '明天下午三點' } as any;
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
      const secondMessage = { type: 'text', text: '跟客戶開會' } as any;
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
      // 驗證最終的確認訊息是透過 replyMessage 發送
      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken2, expect.objectContaining({
        type: 'template',
        altText: '活動「跟客戶開會」已新增',
      }));
      // 確保沒有呼叫 pushMessage
      expect(mockPushMessage).not.toHaveBeenCalled();
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
        const firstMessage = { type: 'text', text: '每週一早上九點的站立會議' } as any;
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
        const secondMessage = { type: 'text', text: '重複十次' } as any;
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

    it('should ask for confirmation when a conflicting event is found', async () => {
      const userId = 'multi-turn-user';
      const replyToken = 'reply-token-conflict';
      const eventToCreate = {
        title: '有衝突的會議',
        start: '2025-10-26T10:00:00+08:00',
        end: '2025-10-26T11:00:00+08:00',
      };
      const message = { type: 'text', text: '明天十點有個有衝突的會議' } as any;
      
      const conflictingEvent = {
        summary: '已經存在的會議',
        start: { dateTime: '2025-10-26T10:30:00+08:00' },
        end: { dateTime: '2025-10-26T11:30:00+08:00' },
      };

      // --- Setup Mocks ---
      mockClassifyIntent.mockResolvedValue({ type: 'create_event', event: eventToCreate });
      mockRedisGet.mockResolvedValue(undefined); // No initial state
      mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
      mockFindEventsInTimeRange.mockResolvedValue([conflictingEvent]); // Simulate finding a conflict

      // --- Execute ---
      await handleTextMessage(replyToken, message, userId);

      // --- Assertions ---
      // 1. State should be set to awaiting_conflict_confirmation
      expect(mockRedisSet).toHaveBeenCalledWith(userId, expect.any(String), 'EX', 3600);
      const stateSet = JSON.parse(mockRedisSet.mock.calls[0][1]);
      expect(stateSet.step).toBe('awaiting_conflict_confirmation');
      expect(stateSet.event).toEqual(eventToCreate);

      // 2. The bot should REPLY with a confirmation template, not PUSH
      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, {
        type: 'template',
        altText: '時間衝突警告',
        template: {
          type: 'buttons',
          title: '⚠️ 時間衝突',
          text: `您預計新增的活動「${eventToCreate.title}」與現有活動時間重疊。是否仍要建立？`,
          actions: [
            { type: 'postback', label: '仍要建立', data: 'action=force_create' },
            { type: 'postback', label: '取消', data: 'action=cancel' },
          ],
        },
      });
      expect(mockPushMessage).not.toHaveBeenCalled(); // Ensure pushMessage was NOT called
    });
  });
