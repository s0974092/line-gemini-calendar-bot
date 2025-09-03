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

jest.mock('./services/geminiService', () => ({
  classifyIntent: jest.fn(),
  parseRecurrenceEndCondition: jest.fn(),
}));

const mockCreateCalendarEvent = jest.fn();
const mockGetCalendarChoicesForUser = jest.fn();
const mockDeleteEvent = jest.fn();
const mockCalendarEventsGet = jest.fn();
const mockFindEventsInTimeRange = jest.fn();

jest.mock('./services/googleCalendarService', () => ({
  createCalendarEvent: mockCreateCalendarEvent,
  getCalendarChoicesForUser: mockGetCalendarChoicesForUser,
  deleteEvent: mockDeleteEvent,
  findEventsInTimeRange: mockFindEventsInTimeRange,
  calendar: {
    events: {
      get: mockCalendarEventsGet,
    },
  },
  DuplicateEventError: class extends Error {
    constructor(message: string, public link: string) {
      super(message);
    }
  },
}));

describe('index.ts unit tests', () => {

  beforeEach(() => {
    // Reset modules and mocks before each test to ensure isolation
    jest.resetModules();
    jest.clearAllMocks();
  });

  describe('handleImageMessage', () => {
    it('should reply with the feature suspension message', async () => {
      const { handleImageMessage } = require('./index');
      await handleImageMessage('mockReplyToken', {} as any, 'mockUserId');
      expect(mockReplyMessage).toHaveBeenCalledWith('mockReplyToken', {
        type: 'text',
        text: '圖片班表功能已暫停，請改用「幫 [姓名] 建立班表」指令來上傳 CSV 檔案。'
      });
    });
  });

  describe('handleFileMessage', () => {
    let handleFileMessage: any;
    let conversationStates: Map<string, any>;

    beforeEach(() => {
      const indexModule = require('./index');
      handleFileMessage = indexModule.handleFileMessage;
      conversationStates = indexModule.conversationStates;
    });

    const userId = 'testUser';
    const replyToken = 'testReplyToken';

    it('should reject if state is not awaiting_csv_upload', async () => {
      const message = { fileName: 'test.csv' } as FileEventMessage;
      await handleFileMessage(replyToken, message, userId);
      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, {
        type: 'text',
        text: '感謝您傳送檔案，但我不知道該如何處理它。如果您想建立班表，請先傳送「幫 [姓名] 建立班表」。'
      });
    });

    it('should reject non-csv files', async () => {
      conversationStates.set(userId, { step: 'awaiting_csv_upload', personName: 'test' });
      const message = { fileName: 'test.txt' } as FileEventMessage;
      await handleFileMessage(replyToken, message, userId);
      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, {
        type: 'text',
        text: '檔案格式錯誤，請上傳 .csv 格式的班表檔案。'
      });
    });
  });

  describe('handlePostbackEvent', () => {
    let handlePostbackEvent: any;
    let conversationStates: Map<string, any>;

    beforeEach(() => {
      const indexModule = require('./index');
      handlePostbackEvent = indexModule.handlePostbackEvent;
      conversationStates = indexModule.conversationStates;
    });
    
    const userId = 'testUser';
    const replyToken = 'testReplyToken';

    it('should cancel operation and clear state when action is cancel', async () => {
      const event = { replyToken, source: { userId }, postback: { data: 'action=cancel' } } as PostbackEvent;
      conversationStates.set(userId, { step: 'awaiting_delete_confirmation', eventId: '123', calendarId: 'primary', timestamp: Date.now() });
      
      await handlePostbackEvent(event);

      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '好的，操作已取消。' });
      expect(conversationStates.has(userId)).toBe(false);
    });

    it('should reply with error if create_after_choice is triggered with invalid state', async () => {
      const event = { replyToken, source: { userId }, postback: { data: 'action=create_after_choice&calendarId=primary' } } as PostbackEvent;
      
      await handlePostbackEvent(event);

      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，您的請求已逾時或無效，請重新操作。' });
    });
    
    it('should reply with error if confirm_delete is triggered with invalid state', async () => {
        const event = { replyToken, source: { userId }, postback: { data: 'action=confirm_delete' } } as PostbackEvent;
        
        await handlePostbackEvent(event);
  
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，您的刪除請求已逾時或無效，請重新操作。' });
    });

    it('should ask for confirmation when action is delete', async () => {
        mockCalendarEventsGet.mockResolvedValue({ data: { summary: 'Event to delete' } });
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'My Calendar' }]);
        const event = { replyToken, source: { userId }, postback: { data: 'action=delete&eventId=event123&calendarId=primary' } } as PostbackEvent;

        await handlePostbackEvent(event);

        expect(mockCalendarEventsGet).toHaveBeenCalledWith({ eventId: 'event123', calendarId: 'primary' });
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, expect.objectContaining({
            type: 'template',
            altText: '確認刪除活動： Event to delete',
        }));
        expect(conversationStates.get(userId)?.step).toBe('awaiting_delete_confirmation');
    });

    it('should handle errors when fetching event for deletion confirmation', async () => {
        mockCalendarEventsGet.mockRejectedValue(new Error('API Error'));
        const event = { replyToken, source: { userId }, postback: { data: 'action=delete&eventId=event123&calendarId=primary' } } as PostbackEvent;

        await handlePostbackEvent(event);

        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，找不到要刪除的活動資訊。' });
    });

    it('should handle createAllShifts action and create events in batches', async () => {
      // 1. Set up state
      const eventsToCreate: CalendarEvent[] = [
        { title: 'Shift 1', start: '2025-01-01T09:00:00+08:00', end: '2025-01-01T17:00:00+08:00', allDay: false, recurrence: null, reminder: 30, calendarId: 'primary' },
        { title: 'Shift 2', start: '2025-01-02T09:00:00+08:00', end: '2025-01-02T17:00:00+08:00', allDay: false, recurrence: null, reminder: 30, calendarId: 'primary' },
      ];
      conversationStates.set(userId, { step: 'awaiting_bulk_confirmation', events: eventsToCreate, timestamp: Date.now() });

      // 2. Mock dependencies
      mockCreateCalendarEvent.mockResolvedValue({ data: { htmlLink: 'link' } });

      // 3. Create event and trigger handler
      const event = { replyToken, source: { userId }, postback: { data: 'action=createAllShifts&calendarId=primary' } } as PostbackEvent;
      await handlePostbackEvent(event);

      // 4. Assertions
      // Initial reply
      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: `收到！正在為您處理 2 個活動...` });

      // Wait for async operations inside the handler to complete
      await new Promise(process.nextTick);

      // Check that createCalendarEvent was called for each event
      expect(mockCreateCalendarEvent).toHaveBeenCalledTimes(2);
      expect(mockCreateCalendarEvent).toHaveBeenCalledWith(eventsToCreate[0], 'primary');
      expect(mockCreateCalendarEvent).toHaveBeenCalledWith(eventsToCreate[1], 'primary');

      // Check for the final push message
      expect(mockPushMessage).toHaveBeenCalledWith(userId, {
        type: 'text',
        text: `批次匯入完成：\n- 新增成功 2 件\n- 已存在 0 件\n- 失敗 0 件`,
      });

      // Check that state is cleared
      expect(conversationStates.has(userId)).toBe(false);
    });

    it('should handle createAllShifts with failures and duplicates', async () => {
      const eventsToCreate: CalendarEvent[] = [
        { title: 'Success', start: '2025-01-01T09:00:00+08:00', end: '2025-01-01T17:00:00+08:00', allDay: false, recurrence: null, reminder: 30, calendarId: 'primary' },
        { title: 'Duplicate', start: '2025-01-02T09:00:00+08:00', end: '2025-01-02T17:00:00+08:00', allDay: false, recurrence: null, reminder: 30, calendarId: 'primary' },
        { title: 'Failure', start: '2025-01-03T09:00:00+08:00', end: '2025-01-03T17:00:00+08:00', allDay: false, recurrence: null, reminder: 30, calendarId: 'primary' },
      ];
      conversationStates.set(userId, { step: 'awaiting_bulk_confirmation', events: eventsToCreate, timestamp: Date.now() });

      const { DuplicateEventError } = require('./services/googleCalendarService');
      mockCreateCalendarEvent
        .mockResolvedValueOnce({ data: { htmlLink: 'link' } }) // Success
        .mockRejectedValueOnce(new DuplicateEventError('Duplicate', 'link')) // Duplicate
        .mockRejectedValueOnce(new Error('API Failure')); // Failure

      const event = { replyToken, source: { userId }, postback: { data: 'action=createAllShifts&calendarId=primary' } } as PostbackEvent;
      await handlePostbackEvent(event);

      await new Promise(process.nextTick);

      expect(mockCreateCalendarEvent).toHaveBeenCalledTimes(3);
      expect(mockPushMessage).toHaveBeenCalledWith(userId, {
        type: 'text',
        text: `批次匯入完成：\n- 新增成功 1 件\n- 已存在 1 件\n- 失敗 1 件`,
      });
    });

  });

  describe('parseCsvToEvents', () => {
    const { parseCsvToEvents } = require('./index');
    const baseCsvContent = `schedule
schedule,,,,,,,,,,,,,,,,,,,,,,,,,,,
姓名,職位,8/31,9/1,9/2,9/3,9/4,9/5,9/6,9/7,9/8,9/9,9/10,9/11,9/12,9/13,9/14,9/15,9/16,9/17,9/18,9/19,9/20,9/21,9/22,9/23,9/24,9/25,9/26,9/27
傅臻,全職,,早接菜,早接菜,晚班,,早接菜,晚班,,早接菜,晚班,早接菜,,,,,早接菜,早接菜,晚班,,假,晚班,,早接菜,晚班,,早接菜,,
怡芳,全職,早班,,晚班,晚班,假,,早接菜,,,晚班,晚班,,早接菜,早接菜,早班,,晚班,晚班,,,早接菜,,,假,,早接菜,,
銘修,全職,早班,晚班,晚班,,早接菜,早接菜,早接菜,,,晚班,,晚班,晚班,晚班,早班,早接菜,早接菜,,晚班,,,,晚班,,晚班,,晚班,
泳舜,全職,,早接菜,早接菜,早接菜,晚班,,,,早班,,,早接菜,早接菜,早接菜,,早接菜,早接菜,晚班,,,,,早接菜,晚班,,酸點單,假,
皓文,全職,,晚班,,,,,,早班,,,晚班,晚班,,晚班,,,早班,,早接菜,早接菜,早接菜,,,,早接菜,晚班,,晚班
淑華,全職,早班,,,早班,早班,早班,,,早班,早班,,,,,早班,早班,,早班,,,,,早班,,早班,,
CJ,,,1430-22,,09-1630,09-1630,1430-22,1430-22,,09-1630,,09-1630,09-1630,09-1630,1430-22,,1430-22,,09-1630,09-1630,09-1630,1430-22,,09-1630,,09-1630,1430-22,1430-22,1430-22
大童支援,0,,,,,,,,,,,,,,,,,,,,,,,,,,,,
`;

    const mockCurrentYear = 2025;
    
    beforeAll(() => {
        Date.prototype.getFullYear = jest.fn(() => mockCurrentYear);
    });

    afterAll(() => {
        jest.restoreAllMocks();
    });

    test('should correctly parse CSV for a specific person', () => {
      const personName = '怡芳';
      const events = parseCsvToEvents(baseCsvContent, personName);
      expect(events).toContainEqual(expect.objectContaining({
        title: '怡芳 早班',
        start: `${mockCurrentYear}-08-31T09:00:00+08:00`,
        end: `${mockCurrentYear}-08-31T17:00:00+08:00`,
      }));
    });

    test('should handle BOM character at the start of CSV content', () => {
        const bomCsvContent = '\uFEFF' + baseCsvContent;
        const personName = '怡芳';
        const events = parseCsvToEvents(bomCsvContent, personName);
        expect(events.length).toBeGreaterThan(0);
        expect(events[0].title).toBe('怡芳 早班');
    });
  });

  describe('processCompleteEvent', () => {
    let processCompleteEvent: any;
    let conversationStates: Map<string, any>;
    let findEventsInTimeRangeMock: jest.Mock;

    beforeEach(() => {
      const indexModule = require('./index');
      processCompleteEvent = indexModule.processCompleteEvent;
      conversationStates = indexModule.conversationStates;
      findEventsInTimeRangeMock = require('./services/googleCalendarService').findEventsInTimeRange;
      mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'My Calendar' }]);
    });

    const userId = 'testUser';
    const replyToken = 'testReplyToken';
    const completeEvent: CalendarEvent = {
      title: 'Test Event',
      start: '2025-01-20T10:00:00+08:00',
      end: '2025-01-20T11:00:00+08:00',
      allDay: false,
      recurrence: null,
      reminder: 30,
      calendarId: 'primary',
    };

    it('should ask for recurrence end condition if rule is incomplete', async () => {
      const eventWithRecurrence = { ...completeEvent, recurrence: 'RRULE:FREQ=DAILY' };
      await processCompleteEvent(replyToken, eventWithRecurrence, userId);

      expect(conversationStates.get(userId)?.step).toBe('awaiting_recurrence_end_condition');
      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, expect.objectContaining({
        text: expect.stringContaining('是一個重複性活動，請問您希望它什麼時候結束？'),
      }));
    });

    it('should ask for calendar choice if multiple calendars exist', async () => {
      mockGetCalendarChoicesForUser.mockResolvedValue([
        { id: 'primary', summary: 'Primary' },
        { id: 'work', summary: 'Work' },
      ]);

      await processCompleteEvent(replyToken, completeEvent, userId);

      expect(conversationStates.get(userId)?.step).toBe('awaiting_calendar_choice');
      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, expect.objectContaining({
        type: 'template',
        altText: `將「${completeEvent.title}」新增至日曆`,
      }));
    });

    it('should warn about conflicts if conflicting events are found', async () => {
      findEventsInTimeRangeMock.mockResolvedValue([{ id: 'conflict', summary: 'Existing Event' }]);
      
      await processCompleteEvent(replyToken, completeEvent, userId);

      expect(conversationStates.get(userId)?.step).toBe('awaiting_conflict_confirmation');
      expect(mockPushMessage).toHaveBeenCalledWith(userId, expect.objectContaining({
        type: 'template',
        altText: '時間衝突警告',
      }));
    });
  });
});
