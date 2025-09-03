import { Client, FileEventMessage, MessageEvent, PostbackEvent, TextEventMessage, WebhookEvent } from '@line/bot-sdk';
import { calendar_v3 } from 'googleapis';
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
  parseTextToCalendarEvent: jest.fn(),
  parseRecurrenceEndCondition: jest.fn(),
  translateRruleToHumanReadable: jest.fn(),
  parseImageToCalendarEvents: jest.fn(),
}));

jest.mock('./services/googleCalendarService', () => ({
  calendar: {
    events: {
      list: jest.fn(),
      insert: jest.fn(),
      patch: jest.fn(),
      delete: jest.fn(),
      get: jest.fn(),
    },
    calendarList: {
      list: jest.fn(),
    },
  },
  createCalendarEvent: jest.fn(),
  deleteEvent: jest.fn(),
  updateEvent: jest.fn(),
  searchEvents: jest.fn(),
  findEventsInTimeRange: jest.fn(),
  DuplicateEventError: class extends Error {
    constructor(message: string, public link: string) {
      super(message);
    }
  },
  getCalendarChoicesForUser: jest.fn(),
}));

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

describe('index.ts 整合測試', () => {
  let classifyIntentMock: jest.Mock;
  let getCalendarChoicesForUserMock: jest.Mock;
  let searchEventsMock: jest.Mock;
  let findEventsInTimeRangeMock: jest.Mock;
  let deleteEventMock: jest.Mock;
  let calendarEventsGetMock: jest.Mock;
  let createCalendarEventMock: jest.Mock;
  let calendarEventsListMock: jest.Mock;

  // Re-import modules for each test to apply env vars
  let appModule: any;
  let handleEvent: (event: WebhookEvent) => Promise<any>;
  let conversationStates: Map<string, any>;


  const WHITELISTED_USER_ID = 'test';

  beforeEach(() => {
    jest.resetModules(); // Reset modules to allow env vars to be applied
    
    // Clear all mocks, including the top-level ones
    jest.clearAllMocks();
    mockReplyMessage.mockClear();
    mockPushMessage.mockClear();
    mockGetMessageContent.mockClear();


    // Set env var before importing the module
    process.env.USER_WHITELIST = WHITELISTED_USER_ID;

    // Now import the module
    appModule = require('./index');
    handleEvent = appModule.handleEvent;
    conversationStates = appModule.conversationStates;

    jest.spyOn(Date, 'now').mockReturnValue(1000000); // Mock Date.now() for consistent testing
    if (conversationStates) {
      conversationStates.clear();
    }

    // Get handles to the mocked services
    classifyIntentMock = require('./services/geminiService').classifyIntent;
    getCalendarChoicesForUserMock = require('./services/googleCalendarService').getCalendarChoicesForUser;
    searchEventsMock = require('./services/googleCalendarService').searchEvents;
    findEventsInTimeRangeMock = require('./services/googleCalendarService').findEventsInTimeRange;
    deleteEventMock = require('./services/googleCalendarService').deleteEvent;
    calendarEventsGetMock = require('./services/googleCalendarService').calendar.events.get;
    createCalendarEventMock = require('./services/googleCalendarService').createCalendarEvent;
    calendarEventsListMock = require('./services/googleCalendarService').calendar.events.list;

    // Default mocks
    getCalendarChoicesForUserMock.mockResolvedValue([{ id: 'primary', summary: '我的主要日曆' }]);
    classifyIntentMock.mockResolvedValue({ type: 'unknown', originalText: 'mock' }); // Add a default mock
    findEventsInTimeRangeMock.mockResolvedValue([]);
    searchEventsMock.mockResolvedValue([]);
    calendarEventsGetMock.mockResolvedValue({ data: { summary: 'Some Event' } });
    createCalendarEventMock.mockResolvedValue({ data: { htmlLink: 'http://example.com/new_event' } });
    calendarEventsListMock.mockResolvedValue({ data: { items: [] } }); // Add this mock
  });

  describe('handleEvent', () => {
    it('應該在狀態超時時清除對話狀態', async () => {
      const timeoutDuration = 10 * 60 * 1000; // 10 minutes
      const expiredTimestamp = Date.now() - timeoutDuration - 1; // Just past the timeout

      conversationStates.set(WHITELISTED_USER_ID, { step: 'awaiting_event_title', timestamp: expiredTimestamp, event: {} });

      const mockEvent = createMockEvent({
        type: 'message',
        replyToken: 'mockReplyToken',
        source: { type: 'user', userId: WHITELISTED_USER_ID },
        message: createMockTextMessage('Hello'),
      }) as MessageEvent;

      await handleEvent(mockEvent);

      expect(conversationStates.has(WHITELISTED_USER_ID)).toBeFalsy();
    });
  });

  describe('handleNewCommand', () => {
    it('query_event: 應該查詢活動並以輪播卡片回覆', async () => {
      const queryIntent: Intent = {
        type: 'query_event',
        timeMin: '2025-01-01T00:00:00+08:00',
        timeMax: '2025-01-01T23:59:59+08:00',
        query: 'Test'
      };
      classifyIntentMock.mockResolvedValue(queryIntent);
      searchEventsMock.mockResolvedValue([
        { id: 'event1', summary: 'Test Event 1', start: { dateTime: '2025-01-01T10:00:00+08:00' }, end: { dateTime: '2025-01-01T11:00:00+08:00' }, organizer: { email: 'primary' } }
      ]);

      const mockEvent = createMockEvent({
        type: 'message',
        replyToken: 'mockReplyToken',
        message: createMockTextMessage('查詢明天 Test'),
      }) as MessageEvent;

      await handleEvent(mockEvent);

      expect(searchEventsMock).toHaveBeenCalledWith('primary', queryIntent.timeMin, queryIntent.timeMax, queryIntent.query);
      expect(mockReplyMessage).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([expect.objectContaining({ type: 'template', altText: '為您找到 1 個活動' })]));
    });

    it('delete_event: 當找到單一活動時，應該要求確認', async () => {
      const deleteIntent: Intent = {
        type: 'delete_event',
        timeMin: '2025-01-01T00:00:00+08:00',
        timeMax: '2025-01-01T23:59:59+08:00',
        query: 'Delete Me'
      };
      classifyIntentMock.mockResolvedValue(deleteIntent);
      searchEventsMock.mockResolvedValue([
        { id: 'event1', summary: 'Delete Me', organizer: { email: 'primary' } }
      ]);

      const mockEvent = createMockEvent({
        type: 'message',
        replyToken: 'mockReplyToken',
        message: createMockTextMessage('刪除 Delete Me'),
      }) as MessageEvent;

      await handleEvent(mockEvent);

      expect(searchEventsMock).toHaveBeenCalled();
      expect(mockReplyMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ type: 'template', altText: '確認刪除活動： Delete Me' }));
      expect(conversationStates.get(WHITELISTED_USER_ID)?.step).toBe('awaiting_delete_confirmation');
    });

    it('delete_event: 當找不到活動時，應該回覆找不到訊息', async () => {
      const deleteIntent: Intent = {
        type: 'delete_event',
        timeMin: '2025-01-01T00:00:00+08:00',
        timeMax: '2025-01-01T23:59:59+08:00',
        query: 'Non-existent'
      };
      classifyIntentMock.mockResolvedValue(deleteIntent);
      searchEventsMock.mockResolvedValue([]);

      const mockEvent = createMockEvent({
        type: 'message',
        replyToken: 'mockReplyToken',
        message: createMockTextMessage('刪除 Non-existent'),
      }) as MessageEvent;

      await handleEvent(mockEvent);

      expect(mockReplyMessage).toHaveBeenCalledWith(expect.any(String), { type: 'text', text: '抱歉，找不到您想刪除的活動。' });
    });

    it('delete_event: 當找到多個活動時，應該要求使用者更明確指出', async () => {
        const deleteIntent: Intent = {
            type: 'delete_event',
            timeMin: '2025-01-01T00:00:00+08:00',
            timeMax: '2025-01-01T23:59:59+08:00',
            query: 'Multiple'
        };
        classifyIntentMock.mockResolvedValue(deleteIntent);
        searchEventsMock.mockResolvedValue([ { id: '1' }, { id: '2' } ] as any);

        const mockEvent = createMockEvent({
            type: 'message',
            replyToken: 'mockReplyToken',
            message: createMockTextMessage('刪除 Multiple'),
        }) as MessageEvent;

        await handleEvent(mockEvent);

        expect(mockReplyMessage).toHaveBeenCalledWith(expect.any(String), { type: 'text', text: '我找到了多個符合條件的活動，請您先用「查詢」功能找到想刪除的活動，然後再點擊該活動下方的「刪除」按鈕。' });
    });

    it('create_event: 當沒有標題但有時間時，應該要求標題', async () => {
        const createIntent: Intent = {
            type: 'create_event',
            event: { start: '2025-01-01T10:00:00+08:00' }
        };
        classifyIntentMock.mockResolvedValue(createIntent);

        const mockEvent = createMockEvent({
            type: 'message',
            replyToken: 'mockReplyToken',
            message: createMockTextMessage('明天早上十點'),
        }) as MessageEvent;

        await handleEvent(mockEvent);

        expect(mockReplyMessage).toHaveBeenCalledWith(expect.any(String), { type: 'text', text: '好的，請問「2025/1/1 10:00」要安排什麼活動呢？' });
        expect(conversationStates.get(WHITELISTED_USER_ID)?.step).toBe('awaiting_event_title');
    });

    it('create_event: 當有標題和時間時，應該直接處理完整事件', async () => {
        const createIntent: Intent = {
            type: 'create_event',
            event: { title: 'Test Event', start: '2025-01-01T10:00:00+08:00', end: '2025-01-01T11:00:00+08:00' }
        };
        classifyIntentMock.mockResolvedValue(createIntent);
        findEventsInTimeRangeMock.mockResolvedValue([]); // No conflicts

        const mockEvent = createMockEvent({
            type: 'message',
            replyToken: 'mockReplyToken',
            message: createMockTextMessage('明天早上十點開會'),
        }) as MessageEvent;

        await handleEvent(mockEvent);

        expect(findEventsInTimeRangeMock).toHaveBeenCalled();
        expect(createCalendarEventMock).toHaveBeenCalledWith(createIntent.event, 'primary');
    });

    it('create_event: 當沒有時間也沒有標題時，應該回覆未知意圖', async () => {
        const createIntent: Intent = {
            type: 'incomplete',
            originalText: 'Hello'
        };
        classifyIntentMock.mockResolvedValue(createIntent);

        const mockEvent = createMockEvent({
            type: 'message',
            replyToken: 'mockReplyToken',
            message: createMockTextMessage('Hello'),
        }) as MessageEvent;

        await handleEvent(mockEvent);

        expect(mockReplyMessage).not.toHaveBeenCalled(); // Should not reply for incomplete/unknown
    });

    it('should handle unknown intent', async () => {
        const unknownIntent: Intent = {
            type: 'unknown',
            originalText: 'What is the weather like?'
        };
        classifyIntentMock.mockResolvedValue(unknownIntent);

        const mockEvent = createMockEvent({
            type: 'message',
            replyToken: 'mockReplyToken',
            message: createMockTextMessage('What is the weather like?'),
        }) as MessageEvent;

        await handleEvent(mockEvent);

        expect(mockReplyMessage).not.toHaveBeenCalled(); // Should not reply for incomplete/unknown
    });
  });

  describe('handlePostbackEvent', () => {
    it('confirm_delete: 應該刪除活動並回覆成功訊息', async () => {
      const state = { step: 'awaiting_delete_confirmation', eventId: 'event1', calendarId: 'primary', timestamp: Date.now() };
      conversationStates.set(WHITELISTED_USER_ID, state);
      deleteEventMock.mockResolvedValue(undefined);

      const mockEvent = createMockEvent({
        type: 'postback',
        replyToken: 'mockReplyToken',
        postback: { data: 'action=confirm_delete' },
      }) as PostbackEvent;

      await handleEvent(mockEvent);

      expect(deleteEventMock).toHaveBeenCalledWith('event1', 'primary');
      expect(mockReplyMessage).toHaveBeenCalledWith(expect.any(String), { type: 'text', text: '活動已成功刪除。' });
      expect(conversationStates.has(WHITELISTED_USER_ID)).toBeFalsy();
    });

    it('create_after_choice: 應該在選擇日曆後檢查衝突並建立活動', async () => {
        const event: Partial<CalendarEvent> = { title: 'New Event', start: '2025-01-01T12:00:00+08:00', end: '2025-01-01T13:00:00+08:00' };
        const state = { step: 'awaiting_calendar_choice', event, timestamp: Date.now() };
        conversationStates.set(WHITELISTED_USER_ID, state);
        findEventsInTimeRangeMock.mockResolvedValue([]); // No conflicts

        const mockEvent = createMockEvent({
            type: 'postback',
            replyToken: 'mockReplyToken',
            postback: { data: 'action=create_after_choice&calendarId=custom_cal' },
        }) as PostbackEvent;

        await handleEvent(mockEvent);

        expect(findEventsInTimeRangeMock).toHaveBeenCalledWith(event.start, event.end, 'custom_cal');
        expect(createCalendarEventMock).toHaveBeenCalledWith(event, 'custom_cal');
        expect(mockReplyMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ text: '收到！正在為您新增活動至 Google 日曆中...' }));
    });

    it('create_after_choice: 當選擇日曆後有衝突時，應該要求確認', async () => {
        const event: Partial<CalendarEvent> = { title: 'New Event', start: '2025-01-01T12:00:00+08:00', end: '2025-01-01T13:00:00+08:00' };
        const state = { step: 'awaiting_calendar_choice', event, timestamp: Date.now() };
        conversationStates.set(WHITELISTED_USER_ID, state);
        findEventsInTimeRangeMock.mockResolvedValue([
            { id: 'existing_event', summary: 'Existing Event', start: { dateTime: '2025-01-01T12:00:00+08:00' } }
        ]);

        const mockEvent = createMockEvent({
            type: 'postback',
            replyToken: 'mockReplyToken',
            postback: { data: 'action=create_after_choice&calendarId=custom_cal' },
        }) as PostbackEvent;

        await handleEvent(mockEvent);

        expect(findEventsInTimeRangeMock).toHaveBeenCalledWith(event.start, event.end, 'custom_cal');
        expect(mockReplyMessage).toHaveBeenCalledWith(expect.any(String), { type: 'text', text: '好的，正在檢查時間衝突...' });
        expect(mockPushMessage).toHaveBeenCalledWith(WHITELISTED_USER_ID, expect.objectContaining({ type: 'template', altText: '時間衝突警告' }));
        expect(conversationStates.get(WHITELISTED_USER_ID)?.step).toBe('awaiting_conflict_confirmation');
    });

    it('force_create: 應該忽略衝突並建立活動', async () => {
        const event: Partial<CalendarEvent> = { title: 'Forced Event', start: '2025-01-01T10:00:00+08:00', end: '2025-01-01T11:00:00+08:00' };
        const state = { step: 'awaiting_conflict_confirmation', event, calendarId: 'primary', timestamp: Date.now() };
        conversationStates.set(WHITELISTED_USER_ID, state);

        const mockEvent = createMockEvent({
            type: 'postback',
            replyToken: 'mockReplyToken',
            postback: { data: 'action=force_create' },
        }) as PostbackEvent;

        await handleEvent(mockEvent);

        expect(createCalendarEventMock).toHaveBeenCalledWith(event, 'primary');
        expect(mockReplyMessage).toHaveBeenCalledWith(expect.any(String), { type: 'text', text: '好的，已忽略衝突，正在為您建立活動...' });
        expect(conversationStates.has(WHITELISTED_USER_ID)).toBeFalsy();
    });

    it('modify: 應該設定狀態並要求修改細節', async () => {
        const eventId = 'event123';
        const calendarId = 'primary';
        const mockEvent = createMockEvent({
            type: 'postback',
            replyToken: 'mockReplyToken',
            postback: { data: `action=modify&eventId=${eventId}&calendarId=${calendarId}` },
        }) as PostbackEvent;

        await handleEvent(mockEvent);

        expect(mockReplyMessage).toHaveBeenCalledWith(expect.any(String), { type: 'text', text: "好的，請問您想如何修改這個活動？\n(例如：標題改為「團隊午餐」、時間改到「明天下午一點」)" });
        expect(conversationStates.get(WHITELISTED_USER_ID)?.step).toBe('awaiting_modification_details');
        expect(conversationStates.get(WHITELISTED_USER_ID)?.eventId).toBe(eventId);
        expect(conversationStates.get(WHITELISTED_USER_ID)?.calendarId).toBe(calendarId);
    });
  });

  describe('handleTextMessage', () => {
    it('handleTitleResponse: 應該處理標題回應並處理完整事件', async () => {
        const event: Partial<CalendarEvent> = { start: '2025-01-01T10:00:00+08:00', end: '2025-01-01T11:00:00+08:00' };
        const state = { step: 'awaiting_event_title', event, timestamp: Date.now() };
        conversationStates.set(WHITELISTED_USER_ID, state);
        const mockMessage = createMockTextMessage('我的新活動標題');

        findEventsInTimeRangeMock.mockResolvedValue([]); // No conflicts

        await appModule.handleTextMessage('mockReplyToken', mockMessage, WHITELISTED_USER_ID);

        const expectedEvent = { ...event, title: '我的新活動標題' };
        expect(createCalendarEventMock).toHaveBeenCalledWith(expectedEvent, 'primary');
        expect(conversationStates.has(WHITELISTED_USER_ID)).toBeFalsy();
    });

    it('handleRecurrenceResponse: 應該處理重複回應並建立活動', async () => {
        const event: Partial<CalendarEvent> = { title: 'Recurring Event', start: '2025-01-01T10:00:00+08:00', recurrence: 'RRULE:FREQ=DAILY' };
        const state = { step: 'awaiting_recurrence_end_condition', event, timestamp: Date.now() };
        conversationStates.set(WHITELISTED_USER_ID, state);
        const mockMessage = createMockTextMessage('重複10次');
        const parseRecurrenceEndConditionMock = require('./services/geminiService').parseRecurrenceEndCondition;
        parseRecurrenceEndConditionMock.mockResolvedValue({ updatedRrule: 'RRULE:FREQ=DAILY;COUNT=10' });

        await appModule.handleTextMessage('mockReplyToken', mockMessage, WHITELISTED_USER_ID);

        expect(parseRecurrenceEndConditionMock).toHaveBeenCalledWith('重複10次', event.recurrence, event.start);
        expect(mockReplyMessage).toHaveBeenCalledWith(expect.any(String), { type: 'text', text: '好的，已為您更新重複規則，正在建立活動... ' });
        expect(createCalendarEventMock).toHaveBeenCalledWith({ ...event, recurrence: 'RRULE:FREQ=DAILY;COUNT=10' }, 'primary');
        expect(conversationStates.has(WHITELISTED_USER_ID)).toBeFalsy();
    });

    it('handleEventUpdate: 應該處理修改細節並更新活動', async () => {
        const eventId = 'event123';
        const calendarId = 'primary';
        const state = { step: 'awaiting_modification_details', eventId, calendarId, timestamp: Date.now() };
        conversationStates.set(WHITELISTED_USER_ID, state);
        const mockMessage = createMockTextMessage('標題改為新標題');
        const updateEventMock = require('./services/googleCalendarService').updateEvent;
        updateEventMock.mockResolvedValue({ summary: '新標題', htmlLink: 'http://example.com/updated' });
        const classifyIntentMock = require('./services/geminiService').classifyIntent;
        classifyIntentMock.mockResolvedValue({ type: 'update_event', changes: { title: '新標題' } });

        await appModule.handleTextMessage('mockReplyToken', mockMessage, WHITELISTED_USER_ID);

        expect(classifyIntentMock).toHaveBeenCalledWith('標題改為新標題');
        expect(updateEventMock).toHaveBeenCalledWith(eventId, calendarId, { summary: '新標題' });
        expect(mockReplyMessage).toHaveBeenCalledWith(expect.any(String), { type: 'text', text: '好的，正在為您更新活動...' });
        expect(mockPushMessage).toHaveBeenCalledWith(WHITELISTED_USER_ID, expect.objectContaining({ type: 'template', altText: '活動已更新' }));
        expect(conversationStates.has(WHITELISTED_USER_ID)).toBeFalsy();
    });
  });
});