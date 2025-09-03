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
    constructor(message: string, public link: string) {
      super(message);
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
  }));
});


describe('index.ts unit tests', () => {

  beforeEach(() => {
    // Reset modules and mocks before each test to ensure isolation
    jest.resetModules();
    jest.clearAllMocks();
    // Mock USER_WHITELIST
    process.env.USER_WHITELIST = 'testUser,anotherUser';
  });

  describe('Redis Error Handling', () => {
    it('should log an error when redis connection fails', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      // To trigger the error, we need to re-require the module after setting up the mock
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

  describe('handleEvent', () => {
    let handleEvent: any;
    const userId = 'testUser';
    const replyToken = 'testReplyToken';

    beforeEach(() => {
      const indexModule = require('./index');
      handleEvent = indexModule.handleEvent;
      mockRedisGet.mockResolvedValue(undefined); // Default to no state
    });

    it('should reject event from non-whitelisted user', async () => {
      const event = {
        type: 'message',
        replyToken,
        source: { userId: 'unknownUser' },
        message: { type: 'text', text: 'hello' },
      } as any;

      const result = await handleEvent(event);
      expect(result).toBeNull();
      expect(mockReplyMessage).not.toHaveBeenCalled();
      expect(mockPushMessage).not.toHaveBeenCalled();
    });

    it('should clear state if it has expired and continue flow', async () => {
      const expiredState = {
        step: 'awaiting_event_title',
        event: {},
        timestamp: Date.now() - (11 * 60 * 1000), // 11 minutes ago
      };
      // First call gets expired state, second call (in handleTextMessage) gets nothing
      mockRedisGet
        .mockResolvedValueOnce(JSON.stringify(expiredState))
        .mockResolvedValueOnce(undefined);
  
      mockClassifyIntent.mockResolvedValue({ type: 'create_event', event: { title: 'test', start: '2025-01-01T10:00:00Z', end: '2025-01-01T11:00:00Z' } });
      mockGetCalendarChoicesForUser.mockResolvedValue([]);
      mockFindEventsInTimeRange.mockResolvedValue([]);
      mockCreateCalendarEvent.mockResolvedValue({ htmlLink: 'link' });
  
      const event = {
        type: 'message',
        replyToken,
        source: { userId },
        message: { type: 'text', text: 'hello' },
      } as any;
  
      await handleEvent(event);
  
      expect(mockRedisDel).toHaveBeenCalledWith(userId);
      expect(mockClassifyIntent).toHaveBeenCalledWith('hello');
    });

    it('should send a welcome message on a "join" event in a room', async () => {
      const event = {
        type: 'join',
        source: { type: 'room', roomId: 'test-room' },
      } as any;

      await handleEvent(event);

      expect(mockPushMessage).toHaveBeenCalledWith('test-room', {
        type: 'text',
        text: expect.stringContaining('哈囉！我是您的 AI 日曆助理'),
      });
    });

    it('should log for unknown join source', async () => {
        const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
        const event = { type: 'join', source: { type: 'user', userId: 'test-user' } } as any;
        await handleEvent(event);
        expect(mockPushMessage).not.toHaveBeenCalled();
        expect(consoleLogSpy).toHaveBeenCalledWith('Bot joined an unknown source type or missing ID.');
        consoleLogSpy.mockRestore();
    });
  });

  describe('handleFileMessage', () => {
    let handleFileMessage: any;

    beforeEach(() => {
      const indexModule = require('./index');
      handleFileMessage = indexModule.handleFileMessage;
    });

    const userId = 'testUser';
    const replyToken = 'testReplyToken';

    it('should ask for calendar choice for CSV if multiple calendars exist', async () => {
        const personName = '怡芳';
        const state = { step: 'awaiting_csv_upload', personName };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
    
        const csvContent = `姓名,職位,9/1,9/2\n${personName},全職,早班,晚班`;
        const mockStream = require('stream').Readable.from(csvContent);
        mockGetMessageContent.mockResolvedValue(mockStream);
    
        const calendars = [
            { id: 'c1', summary: 'Calendar 1' },
            { id: 'c2', summary: 'Calendar 2' },
        ];
        mockGetCalendarChoicesForUser.mockResolvedValue(calendars);
    
        const message = { id: 'mockMessageId', fileName: 'schedule.csv' } as FileEventMessage;
        await handleFileMessage(replyToken, message, userId);
    
        expect(mockReplyMessage).toHaveBeenCalledWith(
            replyToken,
            expect.arrayContaining([
                expect.any(Object), // The summary message
                expect.objectContaining({
                    type: 'template',
                    altText: '請選擇要新增的日曆',
                    template: expect.objectContaining({
                        type: 'buttons',
                        text: '偵測到您有多個日曆，請問您要將這 2 個活動新增至哪個日曆？',
                        actions: [
                            { type: 'postback', label: 'Calendar 1', data: 'action=createAllShifts&calendarId=c1' },
                            { type: 'postback', label: 'Calendar 2', data: 'action=createAllShifts&calendarId=c2' },
                            { type: 'postback', label: '取消', data: 'action=cancel' },
                        ]
                    })
                })
            ])
        );
    });
  });

  describe('handlePostbackEvent', () => {
    let handlePostbackEvent: any;

    beforeEach(() => {
      const indexModule = require('./index');
      handlePostbackEvent = indexModule.handlePostbackEvent;
    });
    
    const userId = 'testUser';
    const replyToken = 'testReplyToken';

    it('should handle "delete" action from query result', async () => {
        const eventId = 'event-to-delete';
        const calendarId = 'cal-to-delete-from';
        const eventDetails = { data: { summary: 'Event to Delete' } };
        mockCalendarEventsGet.mockResolvedValue(eventDetails);
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: calendarId, summary: 'My Test Calendar' }]);

        const postbackData = `action=delete&eventId=${eventId}&calendarId=${calendarId}`;
        const event = { replyToken, source: { userId }, postback: { data: postbackData } } as PostbackEvent;

        await handlePostbackEvent(event);

        expect(mockCalendarEventsGet).toHaveBeenCalledWith({ eventId, calendarId });
        expect(mockRedisSet).toHaveBeenCalledWith(
            userId,
            expect.stringContaining(`"step":"awaiting_delete_confirmation","eventId":"${eventId}"`),
            'EX',
            3600
        );
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, expect.objectContaining({
            type: 'template',
            template: expect.objectContaining({
                type: 'confirm',
                text: `您確定要從「My Test Calendar」日曆中刪除「${eventDetails.data.summary}」嗎？此操作無法復原。`,
            })
        }));
    });

    it('should handle error when fetching event for deletion', async () => {
        mockCalendarEventsGet.mockRejectedValue(new Error('Fetch error'));
        const postbackData = `action=delete&eventId=event1&calendarId=cal1`;
        const event = { replyToken, source: { userId }, postback: { data: postbackData } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，找不到要刪除的活動資訊。' });
    });

    it('should handle createAllShifts general failure', async () => {
        const events: CalendarEvent[] = [
          { title: '小明 早班' } as CalendarEvent,
        ];
        const state = { step: 'awaiting_bulk_confirmation', events };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockCreateCalendarEvent.mockRejectedValue(new Error('API limit reached'));
  
        const postbackData = 'action=createAllShifts&calendarId=primary';
        const event = { replyToken, source: { userId }, postback: { data: postbackData } } as PostbackEvent;
  
        await handlePostbackEvent(event);

        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, {
          type: 'text',
          text: `收到！正在為您處理 1 個活動...`,
        });
        expect(mockPushMessage).toHaveBeenCalledWith(userId, {
          type: 'text',
          text: `批次匯入完成：\n- 新增成功 0 件\n- 已存在 0 件\n- 失敗 1 件`,
        });
        expect(mockRedisDel).toHaveBeenCalledWith(userId);
    });

    it('should handle createAllShifts with mixed results and push a summary', async () => {
        const events: CalendarEvent[] = [
          { title: 'Success' } as CalendarEvent,
          { title: 'Duplicate' } as CalendarEvent,
          { title: 'Failure' } as CalendarEvent,
        ];
        const state = { step: 'awaiting_bulk_confirmation', events };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        
        const { DuplicateEventError } = require('./services/googleCalendarService');

        mockCreateCalendarEvent
            .mockResolvedValueOnce({ htmlLink: 'link1' })
            .mockRejectedValueOnce(new DuplicateEventError('already exists', 'link2'))
            .mockRejectedValueOnce(new Error('API error'));

        const postbackData = 'action=createAllShifts&calendarId=primary';
        const event = { replyToken, source: { userId }, postback: { data: postbackData } } as PostbackEvent;
        
        await handlePostbackEvent(event);

        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, {
          type: 'text',
          text: `收到！正在為您處理 3 個活動...`,
        });
        expect(mockPushMessage).toHaveBeenCalledWith(userId, {
            type: 'text',
            text: `批次匯入完成：\n- 新增成功 1 件\n- 已存在 1 件\n- 失敗 1 件`,
        });
        expect(mockRedisDel).toHaveBeenCalledWith(userId);
    });
  });

  describe('handleEventUpdate', () => {
    let handleTextMessage: any;
    const userId = 'testUser';
    const replyToken = 'testReplyToken';
  
    beforeEach(() => {
      const indexModule = require('./index');
      handleTextMessage = indexModule.handleTextMessage;
      mockRedisGet.mockResolvedValue(undefined);
      mockParseEventChanges.mockClear();
      mockUpdateEvent.mockClear();
    });
  
    it('should ask for clarification if Gemini cannot parse changes', async () => {
      const state = {
        step: 'awaiting_modification_details',
        eventId: 'event1',
        calendarId: 'cal1',
        timestamp: Date.now(),
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(state));
      mockParseEventChanges.mockResolvedValue({ error: 'Could not parse' });
  
      const message = { type: 'text', text: '亂七八糟' } as any;
      await handleTextMessage(replyToken, message, userId);
  
      expect(mockParseEventChanges).toHaveBeenCalledWith('亂七八糟');
      expect(mockUpdateEvent).not.toHaveBeenCalled();
      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, {
        type: 'text',
        text: `抱歉，我不太理解您的修改指令，可以請您說得更清楚一點嗎？\n(例如：時間改到明天下午三點，標題改為「團隊午餐」)`,
      });
    });
  
    it('should update event title and time based on parsed changes', async () => {
      const state = {
        step: 'awaiting_modification_details',
        eventId: 'event1',
        calendarId: 'cal1',
        timestamp: Date.now(),
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(state));
      const changes = {
        title: '新的標題',
        start: '2025-10-27T15:00:00+08:00',
        end: '2025-10-27T16:00:00+08:00',
      };
      mockParseEventChanges.mockResolvedValue(changes);
      const updatedEvent = {
        summary: '新的標題',
        htmlLink: 'http://example.com/updated',
      };
      mockUpdateEvent.mockResolvedValue(updatedEvent);
  
      const message = { type: 'text', text: '標題改成新的標題，時間改到今天下午三點到四點' } as any;
      await handleTextMessage(replyToken, message, userId);
  
      expect(mockRedisDel).toHaveBeenCalledWith(userId);
      expect(mockUpdateEvent).toHaveBeenCalledWith('event1', 'cal1', {
        summary: changes.title,
        start: { dateTime: changes.start, timeZone: 'Asia/Taipei' },
        end: { dateTime: changes.end, timeZone: 'Asia/Taipei' },
      });
      
      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, expect.objectContaining({
        type: 'template',
        altText: '活動已更新',
        template: expect.objectContaining({
          title: '✅ 活動已更新',
          text: `「${updatedEvent.summary}」已更新。`,
          actions: [expect.objectContaining({ uri: updatedEvent.htmlLink })],
        }),
      }));
      expect(mockPushMessage).not.toHaveBeenCalled();
    });
  
    it('should handle update failure and reply with an error message', async () => {
      const state = {
        step: 'awaiting_modification_details',
        eventId: 'event1',
        calendarId: 'cal1',
        timestamp: Date.now(),
      };
      mockRedisGet.mockResolvedValue(JSON.stringify(state));
      mockParseEventChanges.mockResolvedValue({ title: 'New Title' });
      mockUpdateEvent.mockRejectedValue(new Error('API Error'));
  
      const message = { type: 'text', text: '改標題' } as any;
      await handleTextMessage(replyToken, message, userId);
  
      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, {
        type: 'text',
        text: '抱歉，更新活動時發生錯誤。',
      });
      expect(mockPushMessage).not.toHaveBeenCalled();
    });
  });

  describe('parseCsvToEvents', () => {
    const { parseCsvToEvents } = require('./index');
    const mockCurrentYear = new Date().getFullYear();

    it('should handle CSV with BOM', () => {
      const csvContent = '\uFEFF姓名,9/1\nCJ,1430-22';
      const events = parseCsvToEvents(csvContent, 'CJ');
      expect(events.length).toBe(1);
    });

    it('should return empty array if header is not found', () => {
      const csvContent = '職位,9/1\n全職,1430-22';
      const events = parseCsvToEvents(csvContent, 'CJ');
      expect(events).toEqual([]);
    });

    it('should return empty array if only header exists', () => {
      const csvContent = '姓名,9/1';
      const events = parseCsvToEvents(csvContent, 'CJ');
      expect(events).toEqual([]);
    });

    it('should handle empty rows in CSV', () => {
      const csvContent = '姓名,9/1\n\nCJ,1430-22';
      const events = parseCsvToEvents(csvContent, 'CJ');
      expect(events.length).toBe(1);
    });

    it('should return empty array if person is not found', () => {
      const csvContent = '姓名,9/1\nMark,1430-22';
      const events = parseCsvToEvents(csvContent, 'CJ');
      expect(events).toEqual([]);
    });

    it('should skip invalid shift formats', () => {
      const csvContent = '姓名,9/1\nCJ,invalid-shift';
      const events = parseCsvToEvents(csvContent, 'CJ');
      expect(events).toEqual([]);
    });

    it('should correctly parse various shift types', () => {
        const csvContent = `姓名,9/1,9/2,9/3,9/4
CJ,早班,晚班,早接菜,08-12`;
        const events = parseCsvToEvents(csvContent, 'CJ');
        expect(events.length).toBe(4);
        expect(events[0].title).toBe('CJ 早班');
        expect(events[1].title).toBe('CJ 晚班');
        expect(events[2].title).toBe('CJ 早接菜');
        expect(events[3].title).toBe('CJ 早班');
    });
  });

  describe('formatEventTime', () => {
    const { formatEventTime } = require('./index');

    it('should format single all-day event', () => {
        const event = { allDay: true, start: '2025-10-20', end: '2025-10-21' };
        const result = formatEventTime(event);
        expect(result).toContain('2025/10/20 (全天)');
    });

    it('should format multi-day all-day event', () => {
        const event = { allDay: true, start: '2025-10-20', end: '2025-10-23' };
        const result = formatEventTime(event);
        expect(result).toBe('2025/10/20 至 2025/10/22');
    });

    it('should format single-day timed event', () => {
        const event = { start: '2025-10-20T10:00:00+08:00', end: '2025-10-20T12:30:00+08:00' };
        const result = formatEventTime(event);
        expect(result).toBe('2025/10/20 10:00 - 12:30');
    });

    it('should format multi-day timed event', () => {
        const event = { start: '2025-10-20T22:00:00+08:00', end: '2025-10-21T01:30:00+08:00' };
        const result = formatEventTime(event);
        expect(result).toBe('2025/10/20 22:00 - 2025/10/21 01:30');
    });
  });

  describe('sendCreationConfirmation', () => {
    const { sendCreationConfirmation } = require('./index');
    const userId = 'testUser';
    const event: CalendarEvent = { title: 'Test Event', start: '2025-10-20T10:00:00+08:00', end: '2025-10-20T11:00:00+08:00' } as CalendarEvent;

    it('should send a simple message if no event instance is found', async () => {
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockCalendarEventsList.mockResolvedValue({ data: { items: [] } }); // No events found

        await sendCreationConfirmation(userId, event);

        expect(mockPushMessage).toHaveBeenCalledWith(userId, {
            type: 'text',
            text: `✅ 活動「${event.title}」已成功新增，但無法立即取得活動連結。`
        });
    });

    it('should send a carousel if event is found in multiple calendars', async () => {
        mockGetCalendarChoicesForUser.mockResolvedValue([
            { id: 'p1', summary: 'Personal' },
            { id: 'p2', summary: 'Work' },
        ]);
        const eventInstance1 = { summary: event.title, start: { dateTime: event.start }, htmlLink: 'link1' };
        const eventInstance2 = { summary: event.title, start: { dateTime: event.start }, htmlLink: 'link2' };
        mockCalendarEventsList
            .mockResolvedValueOnce({ data: { items: [eventInstance1] } })
            .mockResolvedValueOnce({ data: { items: [eventInstance2] } });

        await sendCreationConfirmation(userId, event);

        expect(mockPushMessage).toHaveBeenCalledWith(userId, [
            { type: 'text', text: `✅ 活動「${event.title}」目前存在於 2 個日曆中。` },
            expect.objectContaining({
                type: 'template',
                template: expect.objectContaining({
                    type: 'carousel',
                    columns: expect.arrayContaining([
                        expect.objectContaining({ actions: [expect.objectContaining({ uri: 'link1' })] }),
                        expect.objectContaining({ actions: [expect.objectContaining({ uri: 'link2' })] }),
                    ])
                })
            })
        ]);
    });
  });

  describe('processCompleteEvent', () => {
    const { processCompleteEvent } = require('./index');
    const userId = 'testUser';
    const replyToken = 'testReplyToken';
    const baseEvent = { title: 'Test', start: '2025-01-01T10:00:00Z', end: '2025-01-01T11:00:00Z' } as CalendarEvent;

    it('should push message for incomplete recurrence if fromImage is true', async () => {
      const eventWithRecurrence = { ...baseEvent, recurrence: 'RRULE:FREQ=DAILY' };
      await processCompleteEvent(replyToken, eventWithRecurrence, userId, true);
      expect(mockPushMessage).toHaveBeenCalledWith(userId, expect.any(Object));
      expect(mockReplyMessage).not.toHaveBeenCalled();
    });

    it('should push message for multiple calendars if fromImage is true', async () => {
      mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'c1', summary: 'c1' }, { id: 'c2', summary: 'c2' }]);
      await processCompleteEvent(replyToken, baseEvent, userId, true);
      expect(mockPushMessage).toHaveBeenCalledWith(userId, expect.any(Object));
      expect(mockReplyMessage).not.toHaveBeenCalled();
    });

    it('should use primary calendar if getCalendarChoicesForUser returns empty', async () => {
      mockGetCalendarChoicesForUser.mockResolvedValue([]);
      mockFindEventsInTimeRange.mockResolvedValue([]);
      mockCreateCalendarEvent.mockResolvedValue({ htmlLink: 'link' });
      await processCompleteEvent(replyToken, baseEvent, userId, false);
      expect(mockCreateCalendarEvent).toHaveBeenCalledWith(baseEvent, 'primary');
    });

    it('should handle generic error from createCalendarEvent', async () => {
        mockGetCalendarChoicesForUser.mockResolvedValue([]);
        mockFindEventsInTimeRange.mockResolvedValue([]);
        const error = new Error('Generic API error');
        mockCreateCalendarEvent.mockRejectedValue(error);
        
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

        await processCompleteEvent(replyToken, baseEvent, userId, false);

        expect(mockPushMessage).toHaveBeenCalledWith(userId, {
            type: 'text',
            text: '抱歉，新增日曆事件時發生錯誤。',
        });
        expect(consoleErrorSpy).toHaveBeenCalledWith("!!!!!!!!!! DETAILED ERROR REPORT START !!!!!!!!!!");
        consoleErrorSpy.mockRestore();
    });
  });

  describe('sendCreationConfirmation complex cases', () => {
    const { sendCreationConfirmation } = require('./index');
    const userId = 'testUser';
    const baseEvent = { title: 'Test', start: '2025-01-01T10:00:00Z', end: '2025-01-01T11:00:00Z' } as CalendarEvent;

    it('should handle createdEventForSeed without organizer email', async () => {
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockCalendarEventsList.mockResolvedValue({ data: { items: [] } });
        await sendCreationConfirmation(userId, baseEvent, { htmlLink: 'link' }); // No organizer
        expect(mockPushMessage).toHaveBeenCalledWith(userId, expect.objectContaining({
            text: expect.stringContaining('無法立即取得活動連結'),
        }));
    });

    it('should handle rejected promises from calendar search', async () => {
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockCalendarEventsList.mockRejectedValue(new Error('API Error'));
        await sendCreationConfirmation(userId, baseEvent);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, expect.objectContaining({
            text: expect.stringContaining('無法立即取得活動連結'),
        }));
    });

    it('should correctly match all-day events', async () => {
        const allDayEvent = { ...baseEvent, allDay: true, start: '2025-10-20', end: '2025-10-21' };
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockCalendarEventsList.mockResolvedValue({
            data: {
                items: [{ summary: allDayEvent.title, start: { date: '2025-10-20' }, htmlLink: 'link' }]
            }
        });
        await sendCreationConfirmation(userId, allDayEvent);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, expect.objectContaining({
            template: expect.objectContaining({
                text: expect.stringContaining('已新增至「Primary」日曆'),
            })
        }));
    });
  });

  describe('formatEventTime edge cases', () => {
    const { formatEventTime } = require('./index');
    it('should return empty string if start or end is missing', () => {
        expect(formatEventTime({ start: '2025-01-01' })).toBe('');
        expect(formatEventTime({ end: '2025-01-01' })).toBe('');
        expect(formatEventTime({})).toBe('');
    });
  });

});

// Helper to run async tests
function runAsync(cb: () => Promise<void>) {
  return (done: jest.DoneCallback) => {
    cb().then(done).catch(done);
  };
}