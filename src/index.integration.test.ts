

import { Client, FileEventMessage, FlexBubble, FlexMessage, MessageEvent, PostbackEvent, TextEventMessage, WebhookEvent } from '@line/bot-sdk';
import { CalendarEvent, Intent } from './services/geminiService';

// Use a local variable to hold the mocked client instance
let mockedLineClientInstance: any;

jest.mock('@line/bot-sdk', () => {
  // Define the mock functions inside the factory to ensure they are consistent
  const mockReplyMessage = jest.fn();
  const mockPushMessage = jest.fn();
  const mockGetMessageContent = jest.fn();

  const MockClient = jest.fn(() => {
    mockedLineClientInstance = {
      replyMessage: mockReplyMessage,
      pushMessage: mockPushMessage,
      getMessageContent: mockGetMessageContent,
    };
    return mockedLineClientInstance;
  });

  return {
    Client: MockClient,
    middleware: jest.fn(() => (req: any, res: any, next: () => any) => next()),
  };
});

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
  let handleEvent: (event: WebhookEvent) => Promise<any>;
  let appModule: any;

  const WHITELISTED_USER_ID = 'test';

  beforeEach(() => {
    jest.resetModules();
    // This will trigger the mock factory and reset the mockedLineClientInstance
    new Client({ channelAccessToken: 'any-test-token' });

    // Clear all service-level mocks
    mockClassifyIntent.mockClear();
    mockParseRecurrenceEndCondition.mockClear();
    mockParseEventChanges.mockClear();
    mockCreateCalendarEvent.mockClear();
    mockGetCalendarChoicesForUser.mockClear();
    mockDeleteEvent.mockClear();
    mockUpdateEvent.mockClear();
    mockSearchEvents.mockClear();
    mockFindEventsInTimeRange.mockClear();
    mockCalendarEventsGet.mockClear();
    mockCalendarEventsList.mockClear();

    conversationStateStore.clear();

    process.env.USER_WHITELIST = WHITELISTED_USER_ID;
    process.env.LINE_CHANNEL_SECRET = 'test_secret';
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
    
    appModule = require('./index');
    handleEvent = appModule.handleEvent;

    jest.spyOn(Date, 'now').mockReturnValue(1000000);

    // Default mocks
    mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: '我的主要日曆' }]);
    mockClassifyIntent.mockResolvedValue({ type: 'unknown', originalText: 'mock' });
    mockFindEventsInTimeRange.mockResolvedValue([]);
    mockSearchEvents.mockResolvedValue({ events: [] });
    mockCalendarEventsGet.mockResolvedValue({ data: { summary: 'Some Event' } });
    mockCreateCalendarEvent.mockResolvedValue({ htmlLink: 'http://example.com/new_event' });
    mockCalendarEventsList.mockResolvedValue({ data: { items: [] } });
  });

  describe('handleEvent', () => {
    it('應該在狀態超時時清除對話狀態', async () => {
      const timeoutDuration = 10 * 60 * 1000;
      const expiredTimestamp = Date.now() - timeoutDuration - 1;
      
      conversationStateStore.set(`state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`, JSON.stringify({ step: 'awaiting_event_title', timestamp: expiredTimestamp, event: {} }));

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
      expect(mockedLineClientInstance.pushMessage).toHaveBeenCalled();
    });

    it('should handle join events for rooms', async () => {
      const mockEvent = createMockEvent({
        type: 'join',
        replyToken: 'mockReplyToken',
        source: { type: 'room', roomId: 'test-room' },
      });

      await handleEvent(mockEvent);
      expect(mockedLineClientInstance.pushMessage).toHaveBeenCalled();
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
    const WHITELISTED_USER_ID = 'test';

    it('should handle successful CSV upload', async () => {
      const csvContent = `姓名,職位,9/3\n傅臻,全職,早班`;
      const message = { id: 'mockMessageId', fileName: 'test.csv' } as FileEventMessage;
      const state = { step: 'awaiting_csv_upload', personName: '傅臻', timestamp: Date.now() };
      const compositeKey = `state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`;
      conversationStateStore.set(compositeKey, JSON.stringify(state));
      const stream = new Readable();
      stream.push(csvContent);
      stream.push(null);
      mockedLineClientInstance.getMessageContent.mockResolvedValue(stream);
      const mockEvent = createMockEvent({ type: 'message', message, source: { type: 'user', userId: WHITELISTED_USER_ID } }) as MessageEvent;

      await appModule.handleFileMessage('mockReplyToken', message, WHITELISTED_USER_ID, mockEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalled();
      const finalState = JSON.parse(conversationStateStore.get(compositeKey));
      expect(finalState.step).toBe('awaiting_bulk_confirmation');
    });

    it('should handle CSV with no events found', async () => {
      const csvContent = `姓名,職位,9/3\n傅臻,全職,休`;
      const message = { id: 'mockMessageId', fileName: 'test.csv' } as FileEventMessage;
      const state = { step: 'awaiting_csv_upload', personName: '傅臻', timestamp: Date.now() };
      const compositeKey = `state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`;
      conversationStateStore.set(compositeKey, JSON.stringify(state));
      const stream = new Readable();
      stream.push(csvContent);
      stream.push(null);
      mockedLineClientInstance.getMessageContent.mockResolvedValue(stream);
      const mockEvent = createMockEvent({ type: 'message', message, source: { type: 'user', userId: WHITELISTED_USER_ID } }) as MessageEvent;

      await appModule.handleFileMessage('mockReplyToken', message, WHITELISTED_USER_ID, mockEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '在您上傳的班表檔案中，找不到「傅臻」的任何班次，或格式不正確。' });
    });

    it('should handle error during file processing', async () => {
      const message = { id: 'mockMessageId', fileName: 'test.csv' } as FileEventMessage;
      const state = { step: 'awaiting_csv_upload', personName: '傅臻', timestamp: Date.now() };
      const compositeKey = `state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`;
      conversationStateStore.set(compositeKey, JSON.stringify(state));
      mockedLineClientInstance.getMessageContent.mockRejectedValue(new Error('test error'));
      const mockEvent = createMockEvent({ type: 'message', message, source: { type: 'user', userId: WHITELISTED_USER_ID } }) as MessageEvent;

      await appModule.handleFileMessage('mockReplyToken', message, WHITELISTED_USER_ID, mockEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '處理您上傳的檔案時發生錯誤。' });
    });

    it('should reply with an error if state is invalid', async () => {
      const message = { id: 'mockMessageId', fileName: 'test.csv' } as FileEventMessage;
      const mockEvent = createMockEvent({ type: 'message', message, source: { type: 'user', userId: WHITELISTED_USER_ID } }) as MessageEvent;
      // No state is set
      await appModule.handleFileMessage('mockReplyToken', message, WHITELISTED_USER_ID, mockEvent);
      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', {
        type: 'text',
        text: '感謝您傳送檔案，但我不知道該如何處理它。如果您想建立班表，請先傳送「幫 [姓名] 建立班表」。'
      });
    });

    it('should reply with an error for non-csv/xlsx files', async () => {
      const message = { id: 'mockMessageId', fileName: 'test.txt' } as FileEventMessage;
      const state = { step: 'awaiting_csv_upload', personName: '傅臻', timestamp: Date.now() };
      const compositeKey = `state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`;
      conversationStateStore.set(compositeKey, JSON.stringify(state));
      const mockEvent = createMockEvent({ type: 'message', message, source: { type: 'user', userId: WHITELISTED_USER_ID } }) as MessageEvent;

      await appModule.handleFileMessage('mockReplyToken', message, WHITELISTED_USER_ID, mockEvent);
      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', {
        type: 'text',
        text: '檔案格式錯誤，請上傳 .csv 或 .xlsx 格式的班表檔案。'
      });
    });

    it('should handle single calendar choice correctly', async () => {
        const csvContent = `姓名,職位,9/3\n傅臻,全職,早班`;
        const message = { id: 'mockMessageId', fileName: 'test.csv' } as FileEventMessage;
        const state = { step: 'awaiting_csv_upload', personName: '傅臻', timestamp: Date.now() };
        const compositeKey = `state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`;
        conversationStateStore.set(compositeKey, JSON.stringify(state));
        const stream = new Readable();
        stream.push(csvContent);
        stream.push(null);
        mockedLineClientInstance.getMessageContent.mockResolvedValue(stream);
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]); // Single calendar
        const mockEvent = createMockEvent({ type: 'message', message, source: { type: 'user', userId: WHITELISTED_USER_ID } }) as MessageEvent;

        await appModule.handleFileMessage('mockReplyToken', message, WHITELISTED_USER_ID, mockEvent);

        expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith(
            'mockReplyToken',
            expect.arrayContaining([
                expect.any(Object),
                expect.objectContaining({
                    template: expect.objectContaining({
                        text: '您要將這 1 個活動一次全部新增至您的 Google 日曆嗎？',
                        actions: [
                            { type: 'postback', label: '全部新增', data: 'action=createAllShifts&calendarId=primary' },
                            { type: 'postback', label: '取消', data: 'action=cancel' },
                        ]
                    })
                })
            ])
        );
    });
  });



  describe('handlePostbackEvent', () => {
    it('confirm_delete: 應該刪除活動並回覆成功訊息', async () => {
      const state = { step: 'awaiting_delete_confirmation', eventId: 'event1', calendarId: 'primary', timestamp: Date.now() };
      conversationStateStore.set(`state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`, JSON.stringify(state));
      mockDeleteEvent.mockResolvedValue(undefined);

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=confirm_delete' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockDeleteEvent).toHaveBeenCalledWith('event1', 'primary');
      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith(expect.any(String), { type: 'text', text: '活動已成功刪除。' });
      expect(conversationStateStore.has(WHITELISTED_USER_ID)).toBe(false);
    });

    it('should handle create_after_choice with invalid state', async () => {
      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=create_after_choice&calendarId=primary' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，您的請求已逾時或無效，請重新操作。' });
    });

    it('should handle create_after_choice with missing calendarId', async () => {
      const state = { step: 'awaiting_calendar_choice', event: {}, timestamp: Date.now() };
      conversationStateStore.set(`state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`, JSON.stringify(state));

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=create_after_choice' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '錯誤：找不到日曆資訊，請重新操作。' });
    });

    it('should handle create_after_choice with conflicting events', async () => {
      const event = { start: '2025-01-01T10:00:00+08:00', end: '2025-01-01T11:00:00+08:00', title: 'Test Event' };
      const state = { step: 'awaiting_calendar_choice', event, timestamp: Date.now() };
      conversationStateStore.set(`state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`, JSON.stringify(state));
      mockFindEventsInTimeRange.mockResolvedValue([{ summary: 'Existing Event' }]);

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=create_after_choice&calendarId=primary' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', expect.objectContaining({ type: 'template', altText: '時間衝突警告' }));
    });

    it('should handle delete with missing eventId', async () => {
      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=delete&calendarId=primary' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，找不到要刪除的活動資訊。' });
    });

    it('should handle delete with error fetching event', async () => {
      mockCalendarEventsGet.mockRejectedValue(new Error('test error'));

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=delete&eventId=event1&calendarId=primary' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，找不到要刪除的活動資訊。' });
    });

    it('should handle confirm_delete with invalid state', async () => {
      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=confirm_delete' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，您的刪除請求已逾時或無效，請重新操作。' });
    });

    it('should handle confirm_delete with error', async () => {
      const state = { step: 'awaiting_delete_confirmation', eventId: 'event1', calendarId: 'primary', timestamp: Date.now() };
      conversationStateStore.set(`state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`, JSON.stringify(state));
      mockDeleteEvent.mockRejectedValue(new Error('test error'));

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=confirm_delete' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，刪除活動時發生錯誤。' });
    });

    it('should handle modify with missing eventId', async () => {
      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=modify&calendarId=primary' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，找不到要修改的活動資訊。' });
    });

    it('should handle force_create with invalid state', async () => {
      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=force_create' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，您的請求已逾時或無效，請重新操作。' });
    });

    it('should handle force_create with error', async () => {
      const event = { start: '2025-01-01T10:00:00+08:00', end: '2025-01-01T11:00:00+08:00', title: 'Test Event' };
      const state = { step: 'awaiting_conflict_confirmation', event, calendarId: 'primary', timestamp: Date.now() };
      conversationStateStore.set(`state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`, JSON.stringify(state));
      mockCreateCalendarEvent.mockRejectedValue(new Error('test error'));

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=force_create' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockedLineClientInstance.pushMessage).toHaveBeenCalledWith(WHITELISTED_USER_ID, { type: 'text', text: '抱歉，新增日曆事件時發生錯誤。' });
    });

    it('should handle createAllShifts with invalid state', async () => {
      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=createAllShifts&calendarId=primary' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '抱歉，您的批次新增請求已逾時或無效，請重新上傳檔案。' });
    });

    it('should handle createAllShifts with missing calendarId', async () => {
      const state = { step: 'awaiting_bulk_confirmation', events: [], timestamp: Date.now() };
      conversationStateStore.set(`state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`, JSON.stringify(state));

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=createAllShifts' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', { type: 'text', text: '錯誤：找不到日曆資訊，請重新操作。' });
    });

    it('should handle createAllShifts with calendarId=all', async () => {
      const events = [{ title: 'Test Event', start: '2025-01-01T10:00:00+08:00', end: '2025-01-01T11:00:00+08:00' }];
      const state = { step: 'awaiting_bulk_confirmation', events, timestamp: Date.now() };
      conversationStateStore.set(`state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`, JSON.stringify(state));
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

    it('should handle createAllShifts with mixed results in a group chat', async () => {
      const events = [
        { title: 'Success' },
        { title: 'Duplicate' },
        { title: 'Failure' },
      ];
      const groupId = 'test-group-id';
      const state = { step: 'awaiting_bulk_confirmation', events, timestamp: Date.now() };
      // Use composite key for state, simulating group context
      const compositeKey = `state:${WHITELISTED_USER_ID}:${groupId}`;
      conversationStateStore.set(compositeKey, JSON.stringify(state));

      mockCreateCalendarEvent.mockImplementation(event => {
        if (event.title === 'Success') return Promise.resolve({});
        if (event.title === 'Duplicate') return Promise.reject(new (require('./services/googleCalendarService').DuplicateEventError)('duplicate', 'http://example.com'));
        return Promise.reject(new Error('failure'));
      });

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        // Simulate event from a group
        source: { type: 'group', groupId, userId: WHITELISTED_USER_ID },
        postback: { data: 'action=createAllShifts&calendarId=primary' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('mockReplyToken', {
        type: 'text',
        text: '收到！正在為您處理 3 個活動...',
      });
      // Assert that the push message is sent to the groupId, not the userId
      expect(mockedLineClientInstance.pushMessage).toHaveBeenCalledWith(groupId, { type: 'text', text: `批次匯入完成：\n- 新增成功 1 件\n- 已存在 1 件\n- 失敗 1 件` });
      // Assert that the correct state is cleared
      expect(conversationStateStore.has(compositeKey)).toBe(false);
    });

    it('create_after_choice: 應該在選擇日曆後成功建立活動並回覆樣板訊息', async () => {
      // Arrange
      const eventData: Partial<CalendarEvent> = {
        title: '家庭聚餐',
        start: '2025-09-28T14:00:00+08:00',
        end: '2025-09-28T16:00:00+08:00',
        allDay: false,
      };
      const state = { step: 'awaiting_calendar_choice', event: eventData, timestamp: Date.now() };
      conversationStateStore.set(`state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`, JSON.stringify(state));

      const createdEvent = { htmlLink: 'https://calendar.google.com/event?eid=mock-event-id' };
      mockCreateCalendarEvent.mockResolvedValue(createdEvent);

      const calendarId = 'family-calendar@group.calendar.google.com';
      const calendarName = '家庭日曆';
      mockGetCalendarChoicesForUser.mockResolvedValue([
        { id: 'primary', summary: '個人' },
        { id: calendarId, summary: calendarName },
      ]);

      const mockPostbackEvent = createMockEvent({
        type: 'postback',
        replyToken: 'replyTokenForCreateAfterChoice',
        postback: { data: `action=create_after_choice&calendarId=${calendarId}` },
      }) as PostbackEvent;

      // Act
      await handleEvent(mockPostbackEvent);

      // Assert
      // 1. 檢查活動是否以正確的參數建立
      expect(mockCreateCalendarEvent).toHaveBeenCalledTimes(1);
      expect(mockCreateCalendarEvent).toHaveBeenCalledWith(eventData, calendarId);

      // 2. 檢查是否清除了對話狀態
      expect(conversationStateStore.has(WHITELISTED_USER_ID)).toBe(false);

      // 3. 檢查是否用正確的樣板訊息回覆
      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledTimes(1);
      const replyArgs = mockedLineClientInstance.replyMessage.mock.calls[0];
      expect(replyArgs[0]).toBe('replyTokenForCreateAfterChoice');
      
      const flexMessage = replyArgs[1] as FlexMessage;
      expect(flexMessage.type).toBe('flex');
      expect(flexMessage.altText).toBe(`活動已新增：${eventData.title}`);
      
      const bubble = flexMessage.contents as FlexBubble;
      const header = bubble.header?.contents[0] as any;
      expect(header.text).toContain(`已新增至「${calendarName}」`);
      
      const body = bubble.body?.contents[0] as any;
      expect(body.text).toBe(eventData.title);

      const footer = bubble.footer?.contents[0] as any;
      expect(footer.action.type).toBe('uri');
      expect(footer.action.uri).toBe(createdEvent.htmlLink);

      // 4. 確保沒有多餘的 pushMessage
      expect(mockedLineClientInstance.pushMessage).not.toHaveBeenCalled();
    });

    it('should handle cancel action', async () => {
      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'replyTokenForCancel',
        postback: { data: 'action=cancel' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(conversationStateStore.has(WHITELISTED_USER_ID)).toBe(false);
      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('replyTokenForCancel', {
        type: 'text',
        text: '好的，操作已取消。',
      });
    });

    it('should handle DuplicateEventError on create_after_choice', async () => {
        const event = { start: '2025-01-01T10:00:00+08:00', end: '2025-01-01T11:00:00+08:00', title: 'Test Event' };
        const state = { step: 'awaiting_calendar_choice', event, timestamp: Date.now() };
        conversationStateStore.set(`state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`, JSON.stringify(state));
        mockFindEventsInTimeRange.mockResolvedValue([]); // No conflicts
        const duplicateError = new (require('./services/googleCalendarService').DuplicateEventError)('duplicate', 'http://example.com/duplicate');
        mockCreateCalendarEvent.mockRejectedValue(duplicateError);

        const mockEvent = createMockEvent({
            type: 'postback',
            replyToken: 'replyTokenForDuplicate',
            postback: { data: 'action=create_after_choice&calendarId=primary' },
        }) as PostbackEvent;

        await handleEvent(mockEvent);

        expect(mockedLineClientInstance.pushMessage).toHaveBeenCalledWith(WHITELISTED_USER_ID, expect.objectContaining({
            type: 'template',
            altText: '活動已存在',
        }));
    });

    it('should handle successful force_create', async () => {
        const eventData = { title: 'Forced Event', start: '2025-01-01T12:00:00+08:00', end: '2025-01-01T13:00:00+08:00' };
        const state = { step: 'awaiting_conflict_confirmation', event: eventData, calendarId: 'primary', timestamp: Date.now() };
        conversationStateStore.set(`state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`, JSON.stringify(state));
        
        mockCreateCalendarEvent.mockResolvedValue({
            htmlLink: 'http://example.com/forced_event',
            organizer: { email: 'primary' } 
        });
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary Calendar' }]);

        const mockEvent = createMockEvent({
            type: 'postback',
            replyToken: 'replyTokenForForceCreate',
            postback: { data: 'action=force_create' },
        }) as PostbackEvent;

        await handleEvent(mockEvent);

        expect(mockCreateCalendarEvent).toHaveBeenCalledWith(eventData, 'primary');
        // 驗證最終的確認訊息是透過 replyMessage 發送
        expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('replyTokenForForceCreate', expect.objectContaining({
            type: 'flex',
            altText: expect.stringContaining('活動已新增：Forced Event'),
        }));
        // 確保沒有呼叫 pushMessage
        expect(mockedLineClientInstance.pushMessage).not.toHaveBeenCalled();
    });
  });

  describe('handleTextMessage for updates', () => {
    let parseEventChangesMock: jest.Mock;

    beforeEach(() => {
      // 在每個測試前取得 mock 函式的參考
      parseEventChangesMock = require('./services/geminiService').parseEventChanges;
    });

    it('handleNewCommand: update_event - 應該直接更新活動並用 replyMessage 回覆', async () => {
      // Arrange
      const intent: Intent = {
        type: 'update_event',
        query: '下午的會議',
        timeMin: '2025-01-01T12:00:00+08:00',
        timeMax: '2025-01-01T18:00:00+08:00',
        changes: { title: '更新後的團隊會議' },
      };
      mockClassifyIntent.mockResolvedValue(intent);

      const eventToUpdate = {
        id: 'event-to-update-123',
        summary: '團隊會議',
        organizer: { email: 'primary' },
      };
      mockSearchEvents.mockResolvedValue({ events: [eventToUpdate], nextPageToken: null });

      const updatedEvent = {
        summary: '更新後的團隊會議',
        htmlLink: 'https://calendar.google.com/event?eid=updated-event-id',
        start: { dateTime: '2025-01-01T12:00:00+08:00' },
        end: { dateTime: '2025-01-01T13:00:00+08:00' },
      };
      mockUpdateEvent.mockResolvedValue(updatedEvent);

      const mockMessageEvent = createMockEvent({
        type: 'message',
        replyToken: 'replyTokenForUpdate',
        message: createMockTextMessage('把下午的會議標題改為 更新後的團隊會議'),
      }) as MessageEvent;

      // Act
      await handleEvent(mockMessageEvent);

      // Assert
      expect(mockSearchEvents).toHaveBeenCalled();
      expect(mockUpdateEvent).toHaveBeenCalledWith(
        eventToUpdate.id,
        eventToUpdate.organizer.email,
        { summary: intent.changes.title }
      );
      
      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledTimes(1);
      const replyArgs = mockedLineClientInstance.replyMessage.mock.calls[0];
      expect(replyArgs[0]).toBe('replyTokenForUpdate');
      const flexMessage = replyArgs[1] as FlexMessage;
      expect(flexMessage.type).toBe('flex');
      expect(flexMessage.altText).toBe(`活動已更新：${updatedEvent.summary}`);
      const bubble = flexMessage.contents as FlexBubble;
      const body = bubble.body!.contents[0] as any;
      expect(body.text).toBe(updatedEvent.summary);
      expect(mockedLineClientInstance.pushMessage).not.toHaveBeenCalled();
    });

    it('handleEventUpdate - 應該在收到修改指令後更新活動並用 replyMessage 回覆', async () => {
      // Arrange
      const eventId = 'event-to-modify-456';
      const calendarId = 'primary';
      const state = { step: 'awaiting_modification_details', eventId, calendarId, timestamp: Date.now() };
      conversationStateStore.set(`state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`, JSON.stringify(state));

      const changes = { title: '修改後的標題' };
      parseEventChangesMock.mockResolvedValue(changes);

      const updatedEvent = { 
        summary: changes.title, 
        htmlLink: 'https://calendar.google.com/event?eid=modified-event-id', 
        start: { dateTime: '2025-01-01T10:00:00+08:00' },
        end: { dateTime: '2025-01-01T11:00:00+08:00' },
      };
      mockUpdateEvent.mockResolvedValue(updatedEvent);

      const mockMessageEvent = createMockEvent({
        type: 'message',
        replyToken: 'replyTokenForModification',
        message: createMockTextMessage('標題改成 修改後的標題'),
      }) as MessageEvent;

      // Act
      await handleEvent(mockMessageEvent);

      // Assert
      expect(mockUpdateEvent).toHaveBeenCalledWith(eventId, calendarId, { summary: changes.title });
      expect(conversationStateStore.has(WHITELISTED_USER_ID)).toBe(false);
      
      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledTimes(1);
      const replyArgs = mockedLineClientInstance.replyMessage.mock.calls[0];
      expect(replyArgs[0]).toBe('replyTokenForModification');
      const flexMessage = replyArgs[1] as FlexMessage;
      expect(flexMessage.type).toBe('flex');
      expect(flexMessage.altText).toBe(`活動已更新：${updatedEvent.summary}`);
      const bubble = flexMessage.contents as FlexBubble;
      const body = bubble.body!.contents[0] as any;
      expect(body.text).toBe(changes.title);
      expect(mockedLineClientInstance.pushMessage).not.toHaveBeenCalled();
    });

    it('handleEventUpdate - 應該在收到修改地點和備註的指令後更新活動', async () => {
      // Arrange
      const eventId = 'event-to-modify-789';
      const calendarId = 'primary';
      const state = { step: 'awaiting_modification_details', eventId, calendarId, timestamp: Date.now() };
      conversationStateStore.set(`state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`, JSON.stringify(state));

      const changes = { location: '新的會議室', description: '記得帶充電器' };
      parseEventChangesMock.mockResolvedValue(changes);

      const updatedEvent = { 
        id: eventId,
        summary: '原始標題', 
        location: changes.location,
        description: changes.description,
        htmlLink: 'https://calendar.google.com/event?eid=modified-event-id',
        organizer: { email: calendarId },
        start: { dateTime: '2025-01-01T10:00:00+08:00' },
        end: { dateTime: '2025-01-01T11:00:00+08:00' },
      };
      mockUpdateEvent.mockResolvedValue(updatedEvent);

      const mockMessageEvent = createMockEvent({
        type: 'message',
        replyToken: 'replyTokenForLocationUpdate',
        message: createMockTextMessage('地點改到新的會議室，備註是記得帶充電器'),
      }) as MessageEvent;

      // Act
      await handleEvent(mockMessageEvent);

      // Assert
      expect(mockUpdateEvent).toHaveBeenCalledWith(eventId, calendarId, changes);
      
      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledTimes(1);
      const replyArgs = mockedLineClientInstance.replyMessage.mock.calls[0];
      const flexMessage = replyArgs[1] as FlexMessage;
      expect(flexMessage.type).toBe('flex');

      const bubble = flexMessage.contents as any;
      const bodyContents = bubble.body!.contents as any[];

      // Find location component and verify
      const locationBox = bodyContents.find(c => c.type === 'box' && c.contents[0].contents[0].text === '地點');
      expect(locationBox).toBeDefined();
      const locationTextComponent = locationBox.contents[0].contents[1];
      expect(locationTextComponent.text).toBe(changes.location);

      // Find description component and verify
      const descriptionBox = bodyContents.find(c => c.type === 'box' && c.contents[0].contents[0].text === '備註');
      expect(descriptionBox).toBeDefined();
      const descriptionTextComponent = descriptionBox.contents[0].contents[1];
      expect(descriptionTextComponent.text).toBe(changes.description);
    });

    it('handleTextMessage - 應該在對話狀態中透過輸入「取消」來清除狀態', async () => {
      // Arrange
      const state = { step: 'awaiting_modification_details', eventId: '123', calendarId: 'primary', timestamp: Date.now() };
      conversationStateStore.set(`state:${WHITELISTED_USER_ID}:${WHITELISTED_USER_ID}`, JSON.stringify(state));

      const mockMessageEvent = createMockEvent({
        type: 'message',
        replyToken: 'replyTokenForCancelText',
        message: createMockTextMessage('取消'),
      }) as MessageEvent;

      // Act
      await handleEvent(mockMessageEvent);

      // Assert
      expect(conversationStateStore.has(WHITELISTED_USER_ID)).toBe(false);
      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('replyTokenForCancelText', { type: 'text', text: '好的，操作已取消。' });
    });
  });

  describe('handleNewCommand edge cases', () => {
    it('update_event: should ask for clarification if multiple events are found', async () => {
        mockClassifyIntent.mockResolvedValue({ type: 'update_event', query: '會議' });
        mockSearchEvents.mockResolvedValue({ events: [{}, {}], nextPageToken: null });

        const mockMessageEvent = createMockEvent({
            type: 'message',
            replyToken: 'replyTokenForUpdateMultiple',
            message: createMockTextMessage('更新會議'),
        }) as MessageEvent;

        await handleEvent(mockMessageEvent);

        const reply = mockedLineClientInstance.replyMessage.mock.calls[0][1];
        expect(reply[0].type).toBe('text');
        expect(reply[1].type).toBe('flex');
        expect((reply[1] as FlexMessage).contents.type).toBe('carousel');
    });

    it('delete_event: should ask for clarification if multiple events are found', async () => {
        mockClassifyIntent.mockResolvedValue({ type: 'delete_event', query: '會議' });
        mockSearchEvents.mockResolvedValue({ events: [{}, {}], nextPageToken: null });

        const mockMessageEvent = createMockEvent({
            type: 'message',
            replyToken: 'replyTokenForDeleteMultiple',
            message: createMockTextMessage('刪除會議'),
        }) as MessageEvent;

        await handleEvent(mockMessageEvent);

        expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('replyTokenForDeleteMultiple', {
            type: 'text',
            text: '我找到了多個符合條件的活動，請您先用「查詢」功能找到想刪除的活動，然後再點擊該活動下方的「刪除」按鈕。',
        });
    });
  });

  describe('handleRecurrenceResponse error handling', () => {
    let handleRecurrenceResponse: any;
    let parseRecurrenceEndConditionMock: jest.Mock;

    beforeEach(() => {
        handleRecurrenceResponse = require('./index').handleRecurrenceResponse;
        parseRecurrenceEndConditionMock = require('./services/geminiService').parseRecurrenceEndCondition;
    });

    it('should ask again if end condition is unparsable', async () => {
        const state = { step: 'awaiting_recurrence_end_condition', event: { recurrence: 'RRULE:FREQ=DAILY', start: '2025-01-01' }, timestamp: Date.now() };
        parseRecurrenceEndConditionMock.mockResolvedValue({ error: 'unparsable' });

        await handleRecurrenceResponse('reply', { type: 'text', text: '亂說' } as TextEventMessage, 'user', state);

        expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('reply', {
            type: 'text',
            text: expect.stringContaining('抱歉，我不太理解您的意思。'),
        });
    });

    it('should handle create error during recurrence response', async () => {
        const state = { step: 'awaiting_recurrence_end_condition', event: { title: 'test', recurrence: 'RRULE:FREQ=DAILY', start: '2025-01-01' }, timestamp: Date.now() };
        parseRecurrenceEndConditionMock.mockResolvedValue({ updatedRrule: 'RRULE:FREQ=DAILY;COUNT=2' });
        mockCreateCalendarEvent.mockRejectedValue(new Error('Create failed'));

        await handleRecurrenceResponse('reply', { type: 'text', text: '兩次' } as TextEventMessage, 'user', state);
        
        expect(mockedLineClientInstance.pushMessage).toHaveBeenCalledWith('user', {
            type: 'text',
            text: '抱歉，新增日曆事件時發生錯誤。',
        });
    });
  });

  describe('handleEventUpdate error handling', () => {
    let handleEventUpdate: any;
    beforeEach(() => {
        handleEventUpdate = require('./index').handleEventUpdate;
    });
    it('should reply with timeout message if state is missing eventId', async () => {
        const state = { step: 'awaiting_modification_details', timestamp: Date.now() }; // Missing eventId/calendarId
        await handleEventUpdate('reply', { type: 'text', text: 'some change' } as TextEventMessage, 'user', state);
        expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('reply', {
            type: 'text',
            text: '抱歉，請求已逾時，找不到要修改的活動。',
        });
    });
  });

  describe('handleNewCommand for query_event', () => {
    it('should reply with a "no events found" message when no events are found', async () => {
      mockClassifyIntent.mockResolvedValue({
        type: 'query_event',
        query: 'nonexistent event',
        timeMin: '2025-01-01T00:00:00+08:00',
        timeMax: '2025-01-01T23:59:59+08:00',
      });
      mockSearchEvents.mockResolvedValue({ events: [], nextPageToken: null });

      const mockMessageEvent = createMockEvent({
        type: 'message',
        replyToken: 'replyTokenForQueryNotFound',
        message: createMockTextMessage('find nonexistent event'),
      }) as MessageEvent;

      await handleEvent(mockMessageEvent);

      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('replyTokenForQueryNotFound', {
        type: 'text',
        text: '抱歉，找不到與「nonexistent event」相關的未來活動。'
      });
    });

    it('should send a carousel for found events', async () => {
        mockClassifyIntent.mockResolvedValue({
            type: 'query_event',
            query: 'Test Event',
            timeMin: '2025-01-01T00:00:00+08:00',
            timeMax: '2025-01-01T23:59:59+08:00',
        });
        const events = [
            {
              summary: 'Test Event 1',
              start: { dateTime: '2025-10-27T10:00:00+08:00' },
              end: { dateTime: '2025-10-27T11:00:00+08:00' },
              organizer: { email: 'primary' },
              id: 'event1',
              htmlLink: 'link1',
            },
        ];
        mockSearchEvents.mockResolvedValue({ events: events, nextPageToken: null });
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Personal Calendar' }]);

        const mockMessageEvent = createMockEvent({
            type: 'message',
            replyToken: 'replyTokenForQueryFound',
            message: createMockTextMessage('find Test Event'),
        }) as MessageEvent;

        await handleEvent(mockMessageEvent);

        expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('replyTokenForQueryFound', [
            { type: 'text', text: '為您找到 1 個與「Test Event」相關的活動：' },
            expect.objectContaining({
              type: 'flex',
              contents: expect.objectContaining({
                type: 'carousel',
              }),
            }),
        ]);
    });
  });

  describe('handleNewCommand complex cases', () => {
    it('create_event: should default end time if missing', async () => {
      const eventData = { title: 'Event with no end time', start: '2025-11-01T10:00:00+08:00' };
      mockClassifyIntent.mockResolvedValue({ type: 'create_event', event: eventData });
      mockFindEventsInTimeRange.mockResolvedValue([]);
      mockCreateCalendarEvent.mockResolvedValue({ htmlLink: 'link' });

      const mockMessageEvent = createMockEvent({
        type: 'message',
        replyToken: 'replyTokenForDefaultEnd',
        message: createMockTextMessage('some text'),
      }) as MessageEvent;

      await handleEvent(mockMessageEvent);

      const expectedEndDate = new Date(eventData.start);
      expectedEndDate.setHours(expectedEndDate.getHours() + 1);

      expect(mockCreateCalendarEvent).toHaveBeenCalledWith(
        expect.objectContaining({ end: expectedEndDate.toISOString() }),
        'primary'
      );
    });

    it('update_event: should handle update failure', async () => {
        const intent = {
            type: 'update_event',
            query: 'Event to update',
            timeMin: '2025-01-01T00:00:00+08:00',
            timeMax: '2025-01-01T23:59:59+08:00',
            changes: { title: 'New Title' },
        };
        mockClassifyIntent.mockResolvedValue(intent);
        mockSearchEvents.mockResolvedValue({ events: [{ id: 'event1', organizer: { email: 'primary' } }], nextPageToken: null });
        mockUpdateEvent.mockRejectedValue(new Error('Update failed'));

        const mockMessageEvent = createMockEvent({
            type: 'message',
            replyToken: 'replyTokenForUpdateFail',
            message: createMockTextMessage('update event'),
        }) as MessageEvent;

        await handleEvent(mockMessageEvent);

        expect(mockedLineClientInstance.pushMessage).toHaveBeenCalledWith('test', {
            type: 'text',
            text: '抱歉，更新活動時發生錯誤。',
        });
    });

    it('delete_event: should reply if multiple events are found', async () => {
        mockClassifyIntent.mockResolvedValue({ type: 'delete_event', query: 'meeting' });
        mockSearchEvents.mockResolvedValue({ events: [{}, {}], nextPageToken: null });

        const mockMessageEvent = createMockEvent({
            type: 'message',
            replyToken: 'replyTokenForDeleteMultiple',
            message: createMockTextMessage('delete meeting'),
        }) as MessageEvent;

        await handleEvent(mockMessageEvent);

        expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('replyTokenForDeleteMultiple', {
            type: 'text',
            text: '我找到了多個符合條件的活動，請您先用「查詢」功能找到想刪除的活動，然後再點擊該活動下方的「刪除」按鈕。',
        });
    });

    it('should handle create_schedule intent', async () => {
        mockClassifyIntent.mockResolvedValue({ type: 'create_schedule', personName: 'John Doe' });
        
        const mockMessageEvent = createMockEvent({
            type: 'message',
            replyToken: 'replyTokenForCreateSchedule',
            message: createMockTextMessage('create schedule for John Doe'),
        }) as MessageEvent;

        await handleEvent(mockMessageEvent);

        const state = JSON.parse(conversationStateStore.get('state:test:test'));
        expect(state.step).toBe('awaiting_csv_upload');
        expect(state.personName).toBe('John Doe');
        expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith('replyTokenForCreateSchedule', {
            type: 'text',
            text: '好的，請現在傳送您要為「John Doe」分析的班表 CSV 或 XLSX 檔案。',
        });
    });

    it('should do nothing for incomplete or unknown intents', async () => {
        mockClassifyIntent.mockResolvedValue({ type: 'incomplete', originalText: 'incomplete text' });
        const mockMessageEvent1 = createMockEvent({
            type: 'message',
            replyToken: 'replyTokenForIncomplete',
            message: createMockTextMessage('incomplete text'),
        }) as MessageEvent;
        const result1 = await handleEvent(mockMessageEvent1);
        expect(result1).toBeNull();

        mockClassifyIntent.mockResolvedValue({ type: 'unknown', originalText: 'unknown text' });
        const mockMessageEvent2 = createMockEvent({
            type: 'message',
            replyToken: 'replyTokenForUnknown',
            message: createMockTextMessage('unknown text'),
        }) as MessageEvent;
        const result2 = await handleEvent(mockMessageEvent2);
        expect(result2).toBeNull();
    });
  });

  describe('Context-Aware State Management', () => {
    const userId = 'context-user';
    const userChatId = userId; // 1-on-1 chat has chatId === userId
    const groupId = 'group-123';
    const replyToken = 'context-reply-token';
    const { Readable } = require('stream');

    it('should reject file upload in a different context', async () => {
      // 1. User initiates schedule creation in a 1-on-1 chat
      const userContextState = { step: 'awaiting_csv_upload', personName: '傅臻', timestamp: Date.now() };
      const userCompositeKey = `state:${userId}:${userChatId}`;
      conversationStateStore.set(userCompositeKey, JSON.stringify(userContextState));

      // 2. User uploads the file in a group chat
      const message = { id: 'mockMessageId', fileName: 'test.csv' } as FileEventMessage;
      const groupEvent = createMockEvent({
        type: 'message',
        replyToken,
        source: { type: 'group', groupId, userId },
        message,
      }) as MessageEvent;

      await appModule.handleFileMessage(replyToken, message, userId, groupEvent);

      // 3. Assert that the bot ignores the file because the context (chatId) is wrong
      expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith(replyToken, {
        type: 'text',
        text: '感謝您傳送檔案，但我不知道該如何處理它。如果您想建立班表，請先傳送「幫 [姓名] 建立班表」。'
      });
      // Ensure the original state from the 1-on-1 chat was not deleted
      expect(conversationStateStore.has(userCompositeKey)).toBe(true);
    });

    it('should process file upload in the correct group context', async () => {
        // 1. User initiates schedule creation in a group chat
        const personName = '傅臻';
        const state = { step: 'awaiting_csv_upload', personName, timestamp: Date.now() };
        const groupCompositeKey = `state:${userId}:${groupId}`;
        conversationStateStore.set(groupCompositeKey, JSON.stringify(state));

        // 2. User uploads the file in the same group chat
        const message = { id: 'mockMessageId', fileName: 'test.csv' } as FileEventMessage;
        const groupEvent = createMockEvent({
            type: 'message',
            replyToken,
            source: { type: 'group', groupId, userId },
            message,
        }) as MessageEvent;
        
        const csvContent = `姓名,職位,9/3\n${personName},全職,早班`;
        const stream = new Readable();
        stream.push(csvContent);
        stream.push(null);
        mockedLineClientInstance.getMessageContent.mockResolvedValue(stream);

        await appModule.handleFileMessage(replyToken, message, userId, groupEvent);

        // 3. Assert that the file was processed and the state was updated for the group context
        expect(mockedLineClientInstance.replyMessage).toHaveBeenCalledWith(replyToken, expect.any(Array));
        const finalState = JSON.parse(conversationStateStore.get(groupCompositeKey));
        expect(finalState.step).toBe('awaiting_bulk_confirmation');
    });
  });

});
