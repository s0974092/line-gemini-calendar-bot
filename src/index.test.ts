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
  
        handlePostbackEvent(event);
        await new Promise(res => setTimeout(res, 100)); // wait for async block

        expect(mockPushMessage).toHaveBeenCalledWith(userId, {
          type: 'text',
          text: `批次匯入完成：\n- 新增成功 0 件\n- 已存在 0 件\n- 失敗 1 件`,
        });
    }, 15000);

    it('should handle createAllShifts async catch block', async () => {
        const state = { step: 'awaiting_bulk_confirmation', events: [{ title: 'test' }] };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation();
        mockCreateCalendarEvent.mockRejectedValue(new Error('Unexpected error'));

        const postbackData = 'action=createAllShifts&calendarId=primary';
        const event = { replyToken, source: { userId }, postback: { data: postbackData } } as PostbackEvent;
        
        handlePostbackEvent(event);
        await new Promise(res => setTimeout(res, 100)); // wait for async block

        expect(mockPushMessage).toHaveBeenCalledWith(userId, {
            type: 'text',
            text: `批次匯入完成：\n- 新增成功 0 件\n- 已存在 0 件\n- 失敗 1 件`,
        });
        consoleErrorSpy.mockRestore();
    }, 15000);
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
      mockUpdateEvent.mockResolvedValue({
        summary: '新的標題',
        htmlLink: 'http://example.com/updated',
      });
  
      const message = { type: 'text', text: '標題改成新的標題，時間改到今天下午三點到四點' } as any;
      await handleTextMessage(replyToken, message, userId);
  
      expect(mockRedisDel).toHaveBeenCalledWith(userId);
      expect(mockUpdateEvent).toHaveBeenCalledWith('event1', 'cal1', {
        summary: changes.title,
        start: { dateTime: changes.start, timeZone: 'Asia/Taipei' },
        end: { dateTime: changes.end, timeZone: 'Asia/Taipei' },
      });
      expect(mockPushMessage).toHaveBeenCalledWith(userId, expect.objectContaining({
        type: 'template',
        template: expect.objectContaining({
          title: '✅ 活動已更新',
          text: '「新的標題」已更新。',
        }),
      }));
    });
  
    it('should handle update failure', async () => {
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
  
      expect(mockPushMessage).toHaveBeenCalledWith(userId, {
        type: 'text',
        text: '抱歉，更新活動時發生錯誤。',
      });
    });
  });

  describe('parseCsvToEvents', () => {
    const { parseCsvToEvents } = require('./index');
    // Corrected CSV Content
    const baseCsvContent = `schedule
schedule,,,,,,,,,,,,,,,,,,,,,,,,,,,
姓名,職位,8/31,9/1,9/2,9/3,9/4,9/5,9/6,9/7,9/8,9/9,9/10,9/11,9/12,9/13,9/14,9/15,9/16,9/17,9/18,9/19,9/20,9/21,9/22,9/23,9/24,9/25,9/26,9/27
傅臻,全職,,早接菜,早接菜,晚班,,早接菜,晚班,,早接菜,晚班,早接菜,,,,,早接菜,早接菜,晚班,,假,晚班,,早接菜,晚班,,早接菜,,
怡芳,全職,早班,,晚班,晚班,假,,早接菜,,,晚班,晚班,,早接菜,早接菜,早班,,晚班,晚班,,,早接菜,,,假,,早接菜,,
銘修,全職,早班,晚班,晚班,,早接菜,早接菜,早接菜,,,晚班,,晚班,晚班,晚班,早班,早接菜,早接菜,,晚班,,,,晚班,,晚班,,晚班,
泳舜,全職,,早接菜,早接菜,早接菜,晚班,,,,早班,,,早接菜,早接菜,早接菜,,早接菜,早接菜,晚班,,,,,早接菜,晚班,,酸點單,假,
皓文,全職,,晚班,,,,,,早班,,,晚班,晚班,,晚班,,,早班,,早接菜,早接菜,早接菜,,,,早接菜,晚班,,晚班
淑華,全職,早班,,,早班,早班,早班,,,早班,早班,,,,,早班,早班,,早班,,,,,早班,,早班,,
CJ,,1430-22,,0900-1630,0900-1630,1430-22,1430-22,,0900-1630,,0900-1630,0900-1630,0900-1630,1430-22,,1430-22,,0900-1630,0900-1630,0900-1630,1430-22,,0900-1630,,0900-1630,1430-22,1430-22,1430-22
大童支援,0,,,,,,,,,,,,,,,,,,,,,,,,,,,,`;

    const mockCurrentYear = 2025;
    
    beforeAll(() => {
        const mockDate = new Date(mockCurrentYear, 8, 1); // Sep 1, 2025
        jest.spyOn(global, 'Date').mockImplementation(() => mockDate as any);
    });

    afterAll(() => {
        jest.restoreAllMocks();
    });

    test('should correctly parse time-based shifts like "1430-22"', () => {
        const personName = 'CJ';
        const events = parseCsvToEvents(baseCsvContent, personName);
        expect(events).toContainEqual(expect.objectContaining({
            title: 'CJ 晚七',
            start: `${mockCurrentYear}-08-31T14:30:00+08:00`,
            end: `${mockCurrentYear}-08-31T22:00:00+08:00`,
        }));
        expect(events).toContainEqual(expect.objectContaining({
            title: 'CJ 早七',
            start: `${mockCurrentYear}-09-02T09:00:00+08:00`,
            end: `${mockCurrentYear}-09-02T16:30:00+08:00`,
        }));
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

});

// Helper to run async tests
function runAsync(cb: () => Promise<void>) {
  return (done: jest.DoneCallback) => {
    cb().then(done).catch(done);
  };
}
