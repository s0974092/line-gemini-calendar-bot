


import { Client, FileEventMessage, MessageEvent, PostbackEvent, TextEventMessage, WebhookEvent } from '@line/bot-sdk';
import { CalendarEvent, Intent } from './services/geminiService';

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
const mockUpdateEvent = jest.fn();
const mockSearchEvents = jest.fn();
const mockFindEventsInTimeRange = jest.fn();
const mockCalendarEventsGet = jest.fn();
const mockCalendarEventsList = jest.fn();

jest.mock('./services/googleCalendarService', () => ({
  createCalendarEvent: mockCreateCalendarEvent,
  getCalendarChoicesForUser: mockGetCalendarChoicesForUser,
  deleteEvent: mockDeleteEvent,
  updateEvent: mockUpdateEvent,
  searchEvents: mockSearchEvents,
  findEventsInTimeRange: mockFindEventsInTimeRange,
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

const conversationStateStore = new Map<string, any>();

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: jest.fn(async (key) => conversationStateStore.get(key)),
    set: jest.fn(async (key, value) => conversationStateStore.set(key, value)),
    del: jest.fn(async (key) => conversationStateStore.delete(key)),
    on: jest.fn(),
  }));
});


// Helper to create mock events with all required properties
const createMockEvent = (event: Partial<WebhookEvent>): WebhookEvent => {
  const baseEvent = {
    mode: 'active' as const,
    timestamp: Date.now(),
    source: { type: 'user' as const, userId: 'test' },
    webhookEventId: 'testWebhookEventId',
    deliveryContext: { isRedelivery: false },
  };
  return { ...baseEvent, ...event } as WebhookEvent;
};

const createMockTextMessage = (text: string): TextEventMessage => ({
  type: 'text',
  id: 'mockMessageId',
  quoteToken: 'mockQuoteToken',
  text,
});

describe('index.ts 整合測試 (Redis Mocked)', () => {
  let classifyIntentMock: jest.Mock;
  let handleEvent: (event: WebhookEvent) => Promise<any>;
  let appModule: any;

  const WHITELISTED_USER_ID = 'test';

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    conversationStateStore.clear();

    process.env.USER_WHITELIST = WHITELISTED_USER_ID;
    
    appModule = require('./index');
    handleEvent = appModule.handleEvent;
    classifyIntentMock = require('./services/geminiService').classifyIntent;

    jest.spyOn(Date, 'now').mockReturnValue(1000000);

    // Default mocks
    mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: '我的主要日曆' }]);
    classifyIntentMock.mockResolvedValue({ type: 'unknown', originalText: 'mock' });
    mockFindEventsInTimeRange.mockResolvedValue([]);
    mockSearchEvents.mockResolvedValue([]);
    mockCalendarEventsGet.mockResolvedValue({ data: { summary: 'Some Event' } });
    mockCreateCalendarEvent.mockResolvedValue({ htmlLink: 'http://example.com/new_event' });
    mockCalendarEventsList.mockResolvedValue({ data: { items: [] } });
  });

  describe('handleEvent', () => {
    it('應該在狀態超時時清除對話狀態', async () => {
      const timeoutDuration = 10 * 60 * 1000;
      const expiredTimestamp = Date.now() - timeoutDuration - 1;
      
      conversationStateStore.set(WHITELISTED_USER_ID, JSON.stringify({ step: 'awaiting_event_title', timestamp: expiredTimestamp, event: {} }));

      const mockEvent = createMockEvent({
        type: 'message',
        replyToken: 'mockReplyToken',
        message: createMockTextMessage('Hello'),
      }) as MessageEvent;

      await handleEvent(mockEvent);

      expect(conversationStateStore.has(WHITELISTED_USER_ID)).toBe(false);
    });

    it('should ignore non-whitelisted users', async () => {
      const mockEvent = createMockEvent({
        type: 'message',
        replyToken: 'mockReplyToken',
        source: { type: 'user', userId: 'not-whitelisted' },
        message: createMockTextMessage('Hello'),
      }) as MessageEvent;

      const result = await handleEvent(mockEvent);
      expect(result).toBeNull();
    });

    it('should handle join events for groups', async () => {
      const mockEvent = createMockEvent({
        type: 'join',
        replyToken: 'mockReplyToken',
        source: { type: 'group', groupId: 'test-group' },
      });

      await handleEvent(mockEvent);
      expect(mockPushMessage).toHaveBeenCalled();
    });

    it('should handle join events for rooms', async () => {
      const mockEvent = createMockEvent({
        type: 'join',
        replyToken: 'mockReplyToken',
        source: { type: 'room', roomId: 'test-room' },
      });

      await handleEvent(mockEvent);
      expect(mockPushMessage).toHaveBeenCalled();
    });

    it('should handle unhandled event types', async () => {
      const mockEvent = createMockEvent({
        type: 'unfollow',
        source: { type: 'user', userId: WHITELISTED_USER_ID },
      }) as WebhookEvent;

      const result = await handleEvent(mockEvent);
      expect(result).toBeNull();
    });
  });

  const { Readable } = require('stream');

describe('handleFileMessage', () => {
    it('should handle successful CSV upload', async () => {
      const csvContent = `姓名,職位,9/3\n傅臻,全職,早班`;
      const message = { id: 'mockMessageId', fileName: 'test.csv' } as FileEventMessage;
      const state = { step: 'awaiting_csv_upload', personName: '傅臻', timestamp: Date.now() };
      conversationStateStore.set(WHITELISTED_USER_ID, JSON.stringify(state));
      const stream = new Readable();
      stream.push(csvContent);
      stream.push(null);
      mockGetMessageContent.mockResolvedValue(stream);

      await appModule.handleFileMessage('mockReplyToken', message, WHITELISTED_USER_ID);

      expect(mockReplyMessage).toHaveBeenCalled();
      const finalState = JSON.parse(conversationStateStore.get(WHITELISTED_USER_ID));
      expect(finalState.step).toBe('awaiting_bulk_confirmation');
    });

    it('should handle CSV with no events found', async () => {
      const csvContent = `姓名,職位,9/3\n傅臻,全職,休`;
      const message = { id: 'mockMessageId', fileName: 'test.csv' } as FileEventMessage;
      const state = { step: 'awaiting_csv_upload', personName: '傅臻', timestamp: Date.now() };
      conversationStateStore.set(WHITELISTED_USER_ID, JSON.stringify(state));
      const stream = new Readable();
      stream.push(csvContent);
      stream.push(null);
      mockGetMessageContent.mockResolvedValue(stream);

      await appModule.handleFileMessage('mockReplyToken', message, WHITELISTED_USER_ID);

      expect(mockReplyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '在您上傳的 CSV 檔案中，找不到「傅臻」的任何班次，或格式不正確。' });
    });

    it('should handle error during file processing', async () => {
      const message = { id: 'mockMessageId', fileName: 'test.csv' } as FileEventMessage;
      const state = { step: 'awaiting_csv_upload', personName: '傅臻', timestamp: Date.now() };
      conversationStateStore.set(WHITELISTED_USER_ID, JSON.stringify(state));
      mockGetMessageContent.mockRejectedValue(new Error('test error'));

      await appModule.handleFileMessage('mockReplyToken', message, WHITELISTED_USER_ID);

      expect(mockReplyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '處理您上傳的 CSV 檔案時發生錯誤。' });
    });
  });


  describe('handlePostbackEvent', () => {
    it('confirm_delete: 應該刪除活動並回覆成功訊息', async () => {
      const state = { step: 'awaiting_delete_confirmation', eventId: 'event1', calendarId: 'primary', timestamp: Date.now() };
      conversationStateStore.set(WHITELISTED_USER_ID, JSON.stringify(state));
      mockDeleteEvent.mockResolvedValue(undefined);

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=confirm_delete' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockDeleteEvent).toHaveBeenCalledWith('event1', 'primary');
      expect(mockReplyMessage).toHaveBeenCalledWith(expect.any(String), { type: 'text', text: '活動已成功刪除。' });
      expect(conversationStateStore.has(WHITELISTED_USER_ID)).toBe(false);
    });

    it('should handle create_after_choice with invalid state', async () => {
      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=create_after_choice&calendarId=primary' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockReplyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，您的請求已逾時或無效，請重新操作。' });
    });

    it('should handle create_after_choice with missing calendarId', async () => {
      const state = { step: 'awaiting_calendar_choice', event: {}, timestamp: Date.now() };
      conversationStateStore.set(WHITELISTED_USER_ID, JSON.stringify(state));

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=create_after_choice' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockReplyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '錯誤：找不到日曆資訊，請重新操作。' });
    });

    it('should handle create_after_choice with conflicting events', async () => {
      const event = { start: '2025-01-01T10:00:00+08:00', end: '2025-01-01T11:00:00+08:00', title: 'Test Event' };
      const state = { step: 'awaiting_calendar_choice', event, timestamp: Date.now() };
      conversationStateStore.set(WHITELISTED_USER_ID, JSON.stringify(state));
      mockFindEventsInTimeRange.mockResolvedValue([{ summary: 'Existing Event' }]);

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=create_after_choice&calendarId=primary' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockPushMessage).toHaveBeenCalledWith(WHITELISTED_USER_ID, expect.objectContaining({ type: 'template', altText: '時間衝突警告' }));
    });

    it('should handle delete with missing eventId', async () => {
      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=delete&calendarId=primary' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockReplyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，找不到要刪除的活動資訊。' });
    });

    it('should handle delete with error fetching event', async () => {
      mockCalendarEventsGet.mockRejectedValue(new Error('test error'));

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=delete&eventId=event1&calendarId=primary' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockReplyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，找不到要刪除的活動資訊。' });
    });

    it('should handle confirm_delete with invalid state', async () => {
      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=confirm_delete' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockReplyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，您的刪除請求已逾時或無效，請重新操作。' });
    });

    it('should handle confirm_delete with error', async () => {
      const state = { step: 'awaiting_delete_confirmation', eventId: 'event1', calendarId: 'primary', timestamp: Date.now() };
      conversationStateStore.set(WHITELISTED_USER_ID, JSON.stringify(state));
      mockDeleteEvent.mockRejectedValue(new Error('test error'));

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=confirm_delete' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockReplyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，刪除活動時發生錯誤。' });
    });

    it('should handle modify with missing eventId', async () => {
      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=modify&calendarId=primary' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockReplyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，找不到要修改的活動資訊。' });
    });

    it('should handle force_create with invalid state', async () => {
      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=force_create' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockReplyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，您的請求已逾時或無效，請重新操作。' });
    });

    it('should handle force_create with error', async () => {
      const event = { start: '2025-01-01T10:00:00+08:00', end: '2025-01-01T11:00:00+08:00', title: 'Test Event' };
      const state = { step: 'awaiting_conflict_confirmation', event, calendarId: 'primary', timestamp: Date.now() };
      conversationStateStore.set(WHITELISTED_USER_ID, JSON.stringify(state));
      mockCreateCalendarEvent.mockRejectedValue(new Error('test error'));

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=force_create' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockPushMessage).toHaveBeenCalledWith(WHITELISTED_USER_ID, { type: 'text', text: '抱歉，新增日曆事件時發生錯誤。' });
    });

    it('should handle createAllShifts with invalid state', async () => {
      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=createAllShifts&calendarId=primary' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockReplyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，您的批次新增請求已逾時或無效，請重新上傳檔案。' });
    });

    it('should handle createAllShifts with missing calendarId', async () => {
      const state = { step: 'awaiting_bulk_confirmation', events: [], timestamp: Date.now() };
      conversationStateStore.set(WHITELISTED_USER_ID, JSON.stringify(state));

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=createAllShifts' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockReplyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '錯誤：找不到日曆資訊，請重新操作。' });
    });

    it('should handle createAllShifts with calendarId=all', async () => {
      const events = [{ title: 'Test Event', start: '2025-01-01T10:00:00+08:00', end: '2025-01-01T11:00:00+08:00' }];
      const state = { step: 'awaiting_bulk_confirmation', events, timestamp: Date.now() };
      conversationStateStore.set(WHITELISTED_USER_ID, JSON.stringify(state));
      mockGetCalendarChoicesForUser.mockResolvedValue([
        { id: 'primary', summary: 'Primary' },
        { id: 'secondary', summary: 'Secondary' },
      ]);

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=createAllShifts&calendarId=all' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockCreateCalendarEvent).toHaveBeenCalledTimes(2);
    });

    it('should handle createAllShifts with mixed results', async () => {
      const events = [
        { title: 'Success' },
        { title: 'Duplicate' },
        { title: 'Failure' },
      ];
      const state = { step: 'awaiting_bulk_confirmation', events, timestamp: Date.now() };
      conversationStateStore.set(WHITELISTED_USER_ID, JSON.stringify(state));
      mockCreateCalendarEvent.mockImplementation(event => {
        if (event.title === 'Success') return Promise.resolve({});
        if (event.title === 'Duplicate') return Promise.reject(new (require('./services/googleCalendarService').DuplicateEventError)('duplicate', 'http://example.com'));
        return Promise.reject(new Error('failure'));
      });

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=createAllShifts&calendarId=primary' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      // We need to wait for the async batch processing to complete
      await new Promise(resolve => setTimeout(resolve, 1000));

      expect(mockPushMessage).toHaveBeenCalledWith(WHITELISTED_USER_ID, { type: 'text', text: `批次匯入完成：\n- 新增成功 1 件\n- 已存在 1 件\n- 失敗 1 件` });
    });
  });

  





});
