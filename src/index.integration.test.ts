import { Client, FileEventMessage, MessageEvent, PostbackEvent, TextEventMessage, WebhookEvent } from '@line/bot-sdk';
import { calendar_v3 } from 'googleapis';
import { CalendarEvent, Intent } from './services/geminiService';

// Mock external dependencies
jest.mock('@line/bot-sdk', () => ({
  Client: jest.fn(() => ({
    replyMessage: jest.fn(),
    pushMessage: jest.fn(),
    getMessageContent: jest.fn(),
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

// Import the main app after mocks are set up
const appModule = require('./index');
const handleEvent = appModule.handleEvent;
const conversationStates = appModule.conversationStates;

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
  let lineClientMock: jest.Mocked<Client>;
  let classifyIntentMock: jest.Mock;
  let createCalendarEventMock: jest.Mock;
  let getCalendarChoicesForUserMock: jest.Mock;
  let searchEventsMock: jest.Mock;
  let findEventsInTimeRangeMock: jest.Mock;
  let deleteEventMock: jest.Mock;
  let calendarEventsGetMock: jest.Mock;

  const WHITELISTED_USER_ID = 'test';

  beforeAll(() => {
    process.env.USER_WHITELIST = WHITELISTED_USER_ID;
  });

  beforeEach(() => {
    jest.clearAllMocks();
    if (conversationStates) {
      conversationStates.clear();
    }

    lineClientMock = new (require('@line/bot-sdk').Client)() as jest.Mocked<Client>;
    classifyIntentMock = require('./services/geminiService').classifyIntent;
    createCalendarEventMock = require('./services/googleCalendarService').createCalendarEvent;
    getCalendarChoicesForUserMock = require('./services/googleCalendarService').getCalendarChoicesForUser;
    searchEventsMock = require('./services/googleCalendarService').searchEvents;
    findEventsInTimeRangeMock = require('./services/googleCalendarService').findEventsInTimeRange;
    deleteEventMock = require('./services/googleCalendarService').deleteEvent;
    calendarEventsGetMock = require('./services/googleCalendarService').calendar.events.get;

    // Default mocks
    getCalendarChoicesForUserMock.mockResolvedValue([{ id: 'primary', summary: '我的主要日曆' }]);
    classifyIntentMock.mockResolvedValue({ type: 'unknown', originalText: 'Hello' });
  });

  describe('handleEvent', () => {
    // it('應該在狀態超時時清除對話狀態', async () => {
    //   const expiredTimestamp = Date.now() - (10 * 60 * 1000) - 1000;
    //   conversationStates.set(WHITELISTED_USER_ID, { step: 'awaiting_event_title', timestamp: expiredTimestamp, event: {} });

    //   const mockEvent = createMockEvent({
    //     type: 'message',
    //     replyToken: 'mockReplyToken',
    //     source: { type: 'user', userId: WHITELISTED_USER_ID },
    //     message: createMockTextMessage('Hello'),
    //   }) as MessageEvent;

    //   await handleEvent(mockEvent);

    //   expect(conversationStates.has(WHITELISTED_USER_ID)).toBeFalsy();
    // });
  });

  describe('handleNewCommand', () => {
    // it('query_event: 應該查詢活動並以輪播卡片回覆', async () => {
    //   const queryIntent: Intent = {
    //     type: 'query_event',
    //     timeMin: '2025-01-01T00:00:00+08:00',
    //     timeMax: '2025-01-01T23:59:59+08:00',
    //     query: 'Test'
    //   };
    //   classifyIntentMock.mockResolvedValue(queryIntent);
    //   searchEventsMock.mockResolvedValue([
    //     { id: 'event1', summary: 'Test Event 1', start: { dateTime: '2025-01-01T10:00:00+08:00' }, end: { dateTime: '2025-01-01T11:00:00+08:00' }, organizer: { email: 'primary' } }
    //   ]);

    //   const mockEvent = createMockEvent({
    //     type: 'message',
    //     replyToken: 'mockReplyToken',
    //     message: createMockTextMessage('查詢明天 Test'),
    //   }) as MessageEvent;

    //   await handleEvent(mockEvent);

    //   expect(searchEventsMock).toHaveBeenCalledWith('primary', queryIntent.timeMin, queryIntent.timeMax, queryIntent.query);
    //   expect(lineClientMock.replyMessage).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining([expect.objectContaining({ type: 'template', altText: '為您找到 1 個活動' })]));
    // });

    // it('delete_event: 當找到單一活動時，應該要求確認', async () => {
    //   const deleteIntent: Intent = {
    //     type: 'delete_event',
    //     timeMin: '2025-01-01T00:00:00+08:00',
    //     timeMax: '2025-01-01T23:59:59+08:00',
    //     query: 'Delete Me'
    //   };
    //   classifyIntentMock.mockResolvedValue(deleteIntent);
    //   searchEventsMock.mockResolvedValue([
    //     { id: 'event1', summary: 'Delete Me', organizer: { email: 'primary' } }
    //   ]);
    //   calendarEventsGetMock.mockResolvedValue({ data: { summary: 'Delete Me' } });

    //   const mockEvent = createMockEvent({
    //     type: 'message',
    //     replyToken: 'mockReplyToken',
    //     message: createMockTextMessage('刪除 Delete Me'),
    //   }) as MessageEvent;

    //   await handleEvent(mockEvent);

    //   expect(searchEventsMock).toHaveBeenCalled();
    //   expect(lineClientMock.replyMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ type: 'template', altText: '確認刪除活動： Delete Me' }));
    //   expect(conversationStates.get(WHITELISTED_USER_ID)?.step).toBe('awaiting_delete_confirmation');
    // });

    // it('delete_event: 當找不到活動時，應該回覆找不到訊息', async () => {
    //   const deleteIntent: Intent = {
    //     type: 'delete_event',
    //     timeMin: '2025-01-01T00:00:00+08:00',
    //     timeMax: '2025-01-01T23:59:59+08:00',
    //     query: 'Non-existent'
    //   };
    //   classifyIntentMock.mockResolvedValue(deleteIntent);
    //   searchEventsMock.mockResolvedValue([]);

    //   const mockEvent = createMockEvent({
    //     type: 'message',
    //     replyToken: 'mockReplyToken',
    //     message: createMockTextMessage('刪除 Non-existent'),
    //   }) as MessageEvent;

    //   await handleEvent(mockEvent);

    //   expect(lineClientMock.replyMessage).toHaveBeenCalledWith(expect.any(String), { type: 'text', text: '抱歉，找不到您想刪除的活動。' });
    // });
  });

  describe('handlePostbackEvent', () => {
    // it('confirm_delete: 應該刪除活動並回覆成功訊息', async () => {
    //   const state = { step: 'awaiting_delete_confirmation', eventId: 'event1', calendarId: 'primary', timestamp: Date.now() };
    //   conversationStates.set(WHITELISTED_USER_ID, state);
    //   deleteEventMock.mockResolvedValue(undefined);

    //   const mockEvent = createMockEvent({
    //     type: 'postback',
    //     replyToken: 'mockReplyToken',
    //     postback: { data: 'action=confirm_delete' },
    //   }) as PostbackEvent;

    //   await handleEvent(mockEvent);

    //   expect(deleteEventMock).toHaveBeenCalledWith('event1', 'primary');
    //   expect(lineClientMock.replyMessage).toHaveBeenCalledWith(expect.any(String), { type: 'text', text: '活動已成功刪除。' });
    //   expect(conversationStates.has(WHITELISTED_USER_ID)).toBeFalsy();
    // });
  });

  describe('processCompleteEvent', () => {
    // it('create_event: 當有時間衝突時，應該要求確認', async () => {
    //   const createIntent: Intent = {
    //     type: 'create_event',
    //     event: { title: 'New Conflicting Event', start: '2025-01-01T10:00:00+08:00', end: '2025-01-01T11:00:00+08:00' }
    //   };
    //   classifyIntentMock.mockResolvedValue(createIntent);
    //   findEventsInTimeRangeMock.mockResolvedValue([
    //     { id: 'existing_event', summary: 'Existing Event' }
    //   ]);

    //   const mockEvent = createMockEvent({
    //     type: 'message',
    //     replyToken: 'mockReplyToken',
    //     message: createMockTextMessage('建立 New Conflicting Event'),
    //   }) as MessageEvent;

    //   await handleEvent(mockEvent);

    //   expect(findEventsInTimeRangeMock).toHaveBeenCalled();
    //   expect(lineClientMock.pushMessage).toHaveBeenCalledWith(WHITELISTED_USER_ID, expect.objectContaining({ type: 'template', altText: '時間衝突警告' }));
    //   expect(conversationStates.get(WHITELISTED_USER_ID)?.step).toBe('awaiting_conflict_confirmation');
    // });

    // it('create_event: 當有多個日曆時，應該要求選擇日曆', async () => {
    //   getCalendarChoicesForUserMock.mockResolvedValue([
    //     { id: 'primary', summary: '我的主要日曆' },
    //     { id: 'custom', summary: '自訂日曆' },
    //   ]);
    //   const createIntent: Intent = {
    //     type: 'create_event',
    //     event: { title: 'New Event', start: '2025-01-01T12:00:00+08:00', end: '2025-01-01T13:00:00+08:00' }
    //   };
    //   classifyIntentMock.mockResolvedValue(createIntent);
    //   findEventsInTimeRangeMock.mockResolvedValue([]); // No conflicts

    //   const mockEvent = createMockEvent({
    //     type: 'message',
    //     replyToken: 'mockReplyToken',
    //     message: createMockTextMessage('建立 New Event'),
    //   }) as MessageEvent;

    //   await handleEvent(mockEvent);

    //   expect(lineClientMock.replyMessage).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ type: 'template', altText: '將「New Event」新增至日曆' }));
    //   expect(conversationStates.get(WHITELISTED_USER_ID)?.step).toBe('awaiting_calendar_choice');
    // });
  });
});