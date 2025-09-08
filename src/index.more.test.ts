import { TextEventMessage, FileEventMessage, PostbackEvent, WebhookEvent } from '@line/bot-sdk';
import { CalendarEvent } from './services/geminiService';
import { Readable } from 'stream';


// Mock external dependencies
const mockReplyMessage = jest.fn();
const mockPushMessage = jest.fn();
const mockGetMessageContent = jest.fn();
const mockCreateCalendarEvent = jest.fn();
const mockGetCalendarChoicesForUser = jest.fn();
const mockDeleteEvent = jest.fn();
const mockCalendarEventsGet = jest.fn();
const mockCalendarEventsList = jest.fn();
const mockFindEventsInTimeRange = jest.fn();
const mockSearchEvents = jest.fn();
const mockUpdateEvent = jest.fn();
const mockClassifyIntent = jest.fn();
const mockParseRecurrenceEndCondition = jest.fn();
const mockParseEventChanges = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisOn = jest.fn();
const mockListen = jest.fn();
const mockAppGet = jest.fn();
const mockAppPost = jest.fn();
const mockMiddleware = jest.fn(() => (req: any, res: any, next: () => any) => next());

jest.mock('@line/bot-sdk', () => ({
  Client: jest.fn(() => ({
    replyMessage: mockReplyMessage,
    pushMessage: mockPushMessage,
    getMessageContent: mockGetMessageContent,
  })),
  middleware: mockMiddleware,
}));

jest.mock('./services/geminiService', () => ({
  classifyIntent: mockClassifyIntent,
  parseRecurrenceEndCondition: mockParseRecurrenceEndCondition,
  parseEventChanges: mockParseEventChanges,
}));

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
    constructor(message: string, public htmlLink: string) {
      super(message);
      this.name = 'DuplicateEventError';
    }
  },
}));

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    on: mockRedisOn,
  }));
});

jest.mock('express', () => {
    const express = jest.requireActual('express');
    const app = {
        get: mockAppGet,
        post: mockAppPost,
        listen: mockListen,
    };
    const constructor = jest.fn(() => app);
    (constructor as any).json = express.json;
    (constructor as any).urlencoded = express.urlencoded;
    return constructor;
});

describe('index.ts final coverage push', () => {
  const userId = 'testUser';
  const replyToken = 'testReplyToken';

  beforeEach(() => {
    jest.resetModules();
    jest.clearAllMocks();
    process.env.LINE_CHANNEL_SECRET = 'test_secret';
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test_token';
    process.env.USER_WHITELIST = 'testUser';
  });

  it('should handle DuplicateEventError correctly', async () => {
    const { handleCreateError } = require('./index');
    const { DuplicateEventError } = require('./services/googleCalendarService');
    const error = new DuplicateEventError('Exists', 'http://example.com/event');
    await handleCreateError(error, userId);
    expect(mockPushMessage).toHaveBeenCalledWith(userId, expect.objectContaining({
        template: expect.objectContaining({ title: '🔍 活動已存在' })
    }));
  });

  it('should ask for title if create_event intent is missing it', async () => {
    const { handleTextMessage } = require('./index');
    mockClassifyIntent.mockResolvedValue({ type: 'create_event', event: { start: '2025-10-27T10:00:00+08:00' } });
    const message = { type: 'text', text: 'some text' } as TextEventMessage;
    await handleTextMessage(replyToken, message, userId);
    expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: expect.stringContaining('要安排什麼活動呢？') });
    expect(mockRedisSet).toHaveBeenCalledWith(userId, expect.stringContaining('awaiting_event_title'), 'EX', 3600);
  });

  it('should handle title response after being asked', async () => {
    const { handleTextMessage } = require('./index');
    const state = { step: 'awaiting_event_title', event: { start: '2025-10-27T10:00:00+08:00' } };
    mockRedisGet.mockResolvedValue(JSON.stringify(state));
    mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
    mockFindEventsInTimeRange.mockResolvedValue([]);
    mockCreateCalendarEvent.mockResolvedValue({ htmlLink: 'link' });
    mockCalendarEventsList.mockResolvedValue({ data: { items: [] } }); // Mock list call

    const message = { type: 'text', text: 'My Awesome Event' } as TextEventMessage;
    await handleTextMessage(replyToken, message, userId);

    expect(mockRedisDel).toHaveBeenCalledWith(userId);
    expect(mockCreateCalendarEvent).toHaveBeenCalledWith(expect.objectContaining({ title: 'My Awesome Event' }), 'primary');
  });

  describe('handleNewCommand', () => {
    it('should handle update_event with more than one event found', async () => {
        const { handleNewCommand } = require('./index');
        mockClassifyIntent.mockResolvedValue({ type: 'update_event', query: 'meeting', timeMin: 'a', timeMax: 'b' });
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary' }]);
        mockSearchEvents.mockResolvedValue({ events: [{}, {}] });
        await handleNewCommand(replyToken, { type: 'text', text: '' } as TextEventMessage, userId);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: expect.stringContaining('找到了多個符合條件的活動') });
    });

    it('should handle update_event with error on update', async () => {
        const { handleNewCommand } = require('./index');
        mockClassifyIntent.mockResolvedValue({ type: 'update_event', query: 'meeting', timeMin: 'a', timeMax: 'b', changes: { title: 'new title' } });
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary' }]);
        mockSearchEvents.mockResolvedValue({ events: [{ id: '1', organizer: { email: 'primary' } }] });
        mockUpdateEvent.mockRejectedValue(new Error('Update failed'));
        await handleNewCommand(replyToken, { type: 'text', text: '' } as TextEventMessage, userId);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, { type: 'text', text: '抱歉，更新活動時發生錯誤。' });
    });

    it('should handle delete_event with more than one event found', async () => {
        const { handleNewCommand } = require('./index');
        mockClassifyIntent.mockResolvedValue({ type: 'delete_event', query: 'meeting', timeMin: 'a', timeMax: 'b' });
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary' }]);
        mockSearchEvents.mockResolvedValue({ events: [{}, {}] });
        await handleNewCommand(replyToken, { type: 'text', text: '' } as TextEventMessage, userId);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: expect.stringContaining('找到了多個符合條件的活動') });
    });

    it('should handle create_schedule intent', async () => {
        const { handleNewCommand } = require('./index');
        mockClassifyIntent.mockResolvedValue({ type: 'create_schedule', personName: 'John' });
        await handleNewCommand(replyToken, { type: 'text', text: '' } as TextEventMessage, userId);
        expect(mockRedisSet).toHaveBeenCalledWith(userId, expect.stringContaining('awaiting_csv_upload'), 'EX', 3600);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: expect.stringContaining('請現在傳送您要為「John」分析的班表 CSV 檔案') });
    });

    it('should handle incomplete intent', async () => {
        const { handleNewCommand } = require('./index');
        mockClassifyIntent.mockResolvedValue({ type: 'incomplete', originalText: '... ' });
        const result = await handleNewCommand(replyToken, { type: 'text', text: '' } as TextEventMessage, userId);
        expect(result).toBeNull();
    });

    it('should handle unknown intent', async () => {
        const { handleNewCommand } = require('./index');
        mockClassifyIntent.mockResolvedValue({ type: 'unknown', originalText: '... ' });
        const result = await handleNewCommand(replyToken, { type: 'text', text: '' } as TextEventMessage, userId);
        expect(result).toBeNull();
    });

    it('should handle default case', async () => {
        const { handleNewCommand } = require('./index');
        mockClassifyIntent.mockResolvedValue({ type: 'some_other_intent' });
        const result = await handleNewCommand(replyToken, { type: 'text', text: '' } as TextEventMessage, userId);
        expect(result).toBeNull();
    });
  });

  describe('handlePostbackEvent', () => {
    it('should handle create_after_choice with missing currentState', async () => {
      const { handlePostbackEvent } = require('./index');
      mockRedisGet.mockResolvedValue(undefined);
      const event = { replyToken, source: { userId }, postback: { data: 'action=create_after_choice&calendarId=primary' } } as PostbackEvent;
      await handlePostbackEvent(event);
      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，您的請求已逾時或無效，請重新操作。' });
    });

    it('should handle create_after_choice with missing calendarId', async () => {
        const { handlePostbackEvent } = require('./index');
        const state = { step: 'awaiting_calendar_choice', event: {} };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        const event = { replyToken, source: { userId }, postback: { data: 'action=create_after_choice' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '錯誤：找不到日曆資訊，請重新操作。' });
    });

    it('should handle create_after_choice with createCalendarEvent error', async () => {
        const { handlePostbackEvent, handleCreateError } = require('./index');
        const state = { step: 'awaiting_calendar_choice', event: { start: 'a', end: 'b' } };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockFindEventsInTimeRange.mockResolvedValue([]);
        mockCreateCalendarEvent.mockRejectedValue(new Error('Create failed'));
        const event = { replyToken, source: { userId }, postback: { data: 'action=create_after_choice&calendarId=primary' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, { type: 'text', text: '抱歉，新增日曆事件時發生錯誤。' });
    });

    it('should handle delete with missing eventId or calendarId', async () => {
        const { handlePostbackEvent } = require('./index');
        const event = { replyToken, source: { userId }, postback: { data: 'action=delete' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，找不到要刪除的活動資訊。' });
    });

    it('should handle delete with calendar.events.get error', async () => {
        const { handlePostbackEvent } = require('./index');
        mockCalendarEventsGet.mockRejectedValue(new Error('Fetch failed'));
        const event = { replyToken, source: { userId }, postback: { data: 'action=delete&eventId=1&calendarId=primary' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，找不到要刪除的活動資訊。' });
    });

    it('should handle confirm_delete with missing currentState', async () => {
        const { handlePostbackEvent } = require('./index');
        mockRedisGet.mockResolvedValue(undefined);
        const event = { replyToken, source: { userId }, postback: { data: 'action=confirm_delete' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，您的刪除請求已逾時或無效，請重新操作。' });
    });

    it('should handle confirm_delete with deleteEvent error', async () => {
        const { handlePostbackEvent } = require('./index');
        const state = { step: 'awaiting_delete_confirmation', eventId: '1', calendarId: 'primary' };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockDeleteEvent.mockRejectedValue(new Error('Delete failed'));
        const event = { replyToken, source: { userId }, postback: { data: 'action=confirm_delete' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，刪除活動時發生錯誤。' });
    });

    it('should handle modify with missing eventId or calendarId', async () => {
        const { handlePostbackEvent } = require('./index');
        const event = { replyToken, source: { userId }, postback: { data: 'action=modify' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，找不到要修改的活動資訊。' });
    });

    it('should handle force_create with missing currentState', async () => {
        const { handlePostbackEvent } = require('./index');
        mockRedisGet.mockResolvedValue(undefined);
        const event = { replyToken, source: { userId }, postback: { data: 'action=force_create' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，您的請求已逾時或無效，請重新操作。' });
    });

    it('should handle force_create with createCalendarEvent error', async () => {
        const { handlePostbackEvent } = require('./index');
        const state = { step: 'awaiting_conflict_confirmation', event: {}, calendarId: 'primary' };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockCreateCalendarEvent.mockRejectedValue(new Error('Create failed'));
        const event = { replyToken, source: { userId }, postback: { data: 'action=force_create' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, { type: 'text', text: '抱歉，新增日曆事件時發生錯誤。' });
    });

    it('should handle createAllShifts with missing currentState', async () => {
        const { handlePostbackEvent } = require('./index');
        mockRedisGet.mockResolvedValue(undefined);
        const event = { replyToken, source: { userId }, postback: { data: 'action=createAllShifts&calendarId=primary' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，您的批次新增請求已逾時或無效，請重新上傳檔案。' });
    });

    it('should handle createAllShifts with missing calendarId', async () => {
        const { handlePostbackEvent } = require('./index');
        const state = { step: 'awaiting_bulk_confirmation', events: [] };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        const event = { replyToken, source: { userId }, postback: { data: 'action=createAllShifts' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '錯誤：找不到日曆資訊，請重新操作。' });
    });

    it('should handle createAllShifts with calendarId=all', async () => {
        const { handlePostbackEvent } = require('./index');
        const state = { step: 'awaiting_bulk_confirmation', events: [{}] };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'cal1' }, { id: 'cal2' }]);
        const event = { replyToken, source: { userId }, postback: { data: 'action=createAllShifts&calendarId=all' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockCreateCalendarEvent).toHaveBeenCalledTimes(2);
    });

    it('should handle createAllShifts with some failures', async () => {
        const { handlePostbackEvent } = require('./index');
        const state = { step: 'awaiting_bulk_confirmation', events: [{}, {}, {}] };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockCreateCalendarEvent.mockResolvedValueOnce({}).mockRejectedValueOnce(new Error('Create failed')).mockResolvedValueOnce({});
        const event = { replyToken, source: { userId }, postback: { data: 'action=createAllShifts&calendarId=primary' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, { type: 'text', text: expect.stringContaining('新增成功 2 件') });
    });

    it('should handle createAllShifts with general error', async () => {
        const { handlePostbackEvent } = require('./index');
        const state = { step: 'awaiting_bulk_confirmation', events: [{}] };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockGetCalendarChoicesForUser.mockRejectedValue(new Error('General error'));
        const event = { replyToken, source: { userId }, postback: { data: 'action=createAllShifts&calendarId=all' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, { type: 'text', text: '批次新增過程中發生未預期的錯誤。' });
    });

    it('should handle unknown action', async () => {
        const { handlePostbackEvent } = require('./index');
        const event = { replyToken, source: { userId }, postback: { data: 'action=unknown' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，發生了未知的錯誤。' });
    });

    it('should handle delete action successfully', async () => {
        const { handlePostbackEvent } = require('./index');
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockCalendarEventsGet.mockResolvedValue({ data: { summary: 'Event to delete' } });
        const event = { replyToken, source: { userId }, postback: { data: 'action=delete&eventId=1&calendarId=primary' } } as PostbackEvent;
        await handlePostbackEvent(event);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, expect.objectContaining({
            template: expect.objectContaining({
                text: expect.stringContaining('您確定要從「Primary」日曆中刪除「Event to delete」嗎？')
            })
        }));
        expect(mockRedisSet).toHaveBeenCalledWith(userId, expect.stringContaining('awaiting_delete_confirmation'), 'EX', 3600);
    });
  });

  describe('handleEventUpdate', () => {
    it('should handle missing eventId or calendarId', async () => {
        const { handleEventUpdate } = require('./index');
        const state = { step: 'awaiting_modification_details' };
        await handleEventUpdate(replyToken, {} as TextEventMessage, userId, state);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，請求已逾時，找不到要修改的活動。' });
    });

    it('should handle parseEventChanges error', async () => {
        const { handleEventUpdate } = require('./index');
        const state = { step: 'awaiting_modification_details', eventId: '1', calendarId: 'primary' };
        mockParseEventChanges.mockResolvedValue({ error: 'parse error' });
        await handleEventUpdate(replyToken, { type: 'text', text: '' } as TextEventMessage, userId, state);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: expect.stringContaining('不太理解您的修改指令') });
    });

    it('should handle updateEvent error', async () => {
        const { handleEventUpdate } = require('./index');
        const state = { step: 'awaiting_modification_details', eventId: '1', calendarId: 'primary' };
        mockParseEventChanges.mockResolvedValue({ title: 'new title' });
        mockUpdateEvent.mockRejectedValue(new Error('Update failed'));
        await handleEventUpdate(replyToken, { type: 'text', text: '' } as TextEventMessage, userId, state);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，更新活動時發生錯誤。' });
    });
  });

  describe('sendCreationConfirmation', () => {
    it('should handle no found instances', async () => {
        const { sendCreationConfirmation } = require('./index');
        mockGetCalendarChoicesForUser.mockResolvedValue([]);
        await sendCreationConfirmation(userId, { title: 'test' } as CalendarEvent);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, { type: 'text', text: expect.stringContaining('無法立即取得活動連結') });
    });

    it('should send a carousel message if event is found in multiple calendars', async () => {
        const { sendCreationConfirmation } = require('./index');
        const event = { title: 'Test', start: '2025-01-01T10:00:00Z', end: '2025-01-01T11:00:00Z', allDay: false };
        const createdEvent = { organizer: { email: 'primary' }, htmlLink: 'link1' };
        
        mockGetCalendarChoicesForUser.mockResolvedValue([
            { id: 'primary', summary: 'Primary' },
            { id: 'secondary', summary: 'Secondary' },
        ]);

        mockCalendarEventsList.mockImplementation(async (args: any) => {
            if (args.calendarId === 'secondary') {
                return { data: { items: [{ summary: 'Test', start: { dateTime: '2025-01-01T10:00:00.000Z' }, htmlLink: 'link2' }] } };
            }
            return { data: { items: [] } };
        });

        await sendCreationConfirmation(userId, event as any, createdEvent as any);

        expect(mockPushMessage).toHaveBeenCalledWith(userId, [
            { type: 'text', text: expect.stringContaining('目前存在於 2 個日曆中') },
            expect.objectContaining({
                type: 'template',
                template: expect.objectContaining({
                    type: 'carousel',
                    columns: expect.any(Array)
                }),
            }),
        ]);
        const carousel = mockPushMessage.mock.calls[0][1][1];
        expect(carousel.template.columns.length).toBe(2);
    });
  });

  describe('handleCreateError', () => {
    it('should handle generic error', async () => {
        const { handleCreateError } = require('./index');
        await handleCreateError(new Error('Generic error'), userId);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, { type: 'text', text: '抱歉，新增日曆事件時發生錯誤。' });
    });
  });

  describe('handleEvent', () => {
    it('should handle join event in a room', async () => {
        const { handleEvent } = require('./index');
        const event = { type: 'join', source: { type: 'room', roomId: 'test-room' } } as any;
        await handleEvent(event);
        expect(mockPushMessage).toHaveBeenCalledWith('test-room', { type: 'text', text: expect.any(String) });
    });

    it('should handle join event with unknown source', async () => {
        const { handleEvent } = require('./index');
        const event = { type: 'join', source: { type: 'user', userId: 'test-user' } } as any;
        const result = await handleEvent(event);
        expect(result).toBeNull();
    });

    it('should handle unhandled event type', async () => {
        const { handleEvent } = require('./index');
        const event = { type: 'unfollow', source: { userId } } as any;
        const result = await handleEvent(event);
        expect(result).toBeNull();
    });
  });

  describe('handleFileMessage', () => {
    it('should handle missing currentState', async () => {
        const { handleFileMessage } = require('./index');
        mockRedisGet.mockResolvedValue(undefined);
        await handleFileMessage(replyToken, { fileName: 'a.csv' } as FileEventMessage, userId);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: expect.stringContaining('不知道該如何處理') });
    });

    it('should handle non-csv file', async () => {
        const { handleFileMessage } = require('./index');
        const state = { step: 'awaiting_csv_upload', personName: 'test' };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        await handleFileMessage(replyToken, { fileName: 'a.txt' } as FileEventMessage, userId);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '檔案格式錯誤，請上傳 .csv 格式的班表檔案。' });
    });

    it('should handle empty events from csv', async () => {
        const { handleFileMessage, parseCsvToEvents } = require('./index');
        const state = { step: 'awaiting_csv_upload', personName: 'test' };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockGetMessageContent.mockResolvedValue(Readable.from('header\n'));
        await handleFileMessage(replyToken, { id: '1', fileName: 'a.csv' } as FileEventMessage, userId);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: expect.stringContaining('找不到「test」的任何班次') });
    });

    it('should handle multiple calendar choices', async () => {
        const { handleFileMessage } = require('./index');
        const state = { step: 'awaiting_csv_upload', personName: 'test' };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockGetMessageContent.mockResolvedValue(Readable.from('姓名,10/26\n"test",0800-1700'));
        mockGetCalendarChoicesForUser.mockResolvedValue([ {id: '1', summary: 'a'}, {id: '2', summary: 'b'} ]);
        await handleFileMessage(replyToken, { id: '1', fileName: 'a.csv' } as FileEventMessage, userId);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, [
            expect.objectContaining({type: 'text'}), 
            expect.objectContaining({ 
                type: 'template', 
                template: expect.objectContaining({ text: expect.stringContaining('偵測到您有多個日曆') })
            })
        ]);
    });

    it('should handle error during file processing', async () => {
        const { handleFileMessage } = require('./index');
        const state = { step: 'awaiting_csv_upload', personName: 'test' };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockGetMessageContent.mockRejectedValue(new Error('Fetch failed'));
        await handleFileMessage(replyToken, { id: '1', fileName: 'a.csv' } as FileEventMessage, userId);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '處理您上傳的 CSV 檔案時發生錯誤。' });
    });
  });

  describe('parseCsvToEvents', () => {
    const { parseCsvToEvents } = require('./index');

    it('should handle BOM', () => {
        const result = parseCsvToEvents('\uFEFF姓名,10/26\n"test",0800-1700', 'test');
        expect(result.length).toBe(1);
    });

    it('should handle header not found', () => {
        const result = parseCsvToEvents('a,b\nc,d', 'test');
        expect(result.length).toBe(0);
    });

    it('should handle not enough data', () => {
        const result = parseCsvToEvents('姓名,10/26', 'test');
        expect(result.length).toBe(0);
    });

    it('should handle person not found', () => {
        const result = parseCsvToEvents('姓名,10/26\n"other",0800-1700', 'test');
        expect(result.length).toBe(0);
    });

    it('should parse various shift types', () => {
        const csv = `姓名,10/26,10/27,10/28,10/29,10/30,10/31,11/1\n"test",0800-1700,早班,晚班,早接菜,假,休,1230-2130`;
        const result = parseCsvToEvents(csv, 'test');
        expect(result.length).toBe(5);
        expect(result[0].title).toBe('test 早班');
        expect(result[1].title).toBe('test 早班');
        expect(result[2].title).toBe('test 晚班');
        expect(result[3].title).toBe('test 早接菜');
        expect(result[4].title).toBe('test 晚班');
    });
  });

  describe('handleRecurrenceResponse', () => {
    it('should ask again if recurrence response is invalid', async () => {
        const { handleRecurrenceResponse } = require('./index');
        const state = { step: 'awaiting_recurrence_end_condition', event: { title: 'test', start: '2025-01-01T10:00:00Z', recurrence: 'RRULE:FREQ=DAILY' }, timestamp: Date.now() };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockParseRecurrenceEndCondition.mockResolvedValue({ error: 'invalid' }); // Mock the error case
        await handleRecurrenceResponse(replyToken, { type: 'text', text: 'invalid response' } as TextEventMessage, userId, state);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, {
            type: 'text',
            text: expect.stringContaining('抱歉，我不太理解您的意思。'),
        });
        expect(mockRedisSet).toHaveBeenCalled(); // State should be updated with new timestamp
    });

    it('should handle create error after valid recurrence response', async () => {
        const { handleRecurrenceResponse } = require('./index');
        const state = { step: 'awaiting_recurrence_end_condition', event: { title: 'test', start: '2025-01-01T10:00:00Z', recurrence: 'RRULE:FREQ=DAILY' }, timestamp: Date.now() };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockParseRecurrenceEndCondition.mockResolvedValue({ updatedRrule: 'RRULE:FREQ=DAILY;COUNT=5' });
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockFindEventsInTimeRange.mockResolvedValue([]);
        mockCreateCalendarEvent.mockRejectedValue(new Error('Create failed'));
        await handleRecurrenceResponse(replyToken, { type: 'text', text: '5 times' } as TextEventMessage, userId, state);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, { type: 'text', text: '抱歉，新增日曆事件時發生錯誤。' });
    });
  });

  describe('processCompleteEvent', () => {
    it('should send conflict confirmation if events overlap', async () => {
      const { processCompleteEvent } = require('./index');
      const event = { title: 'Clashing Event', start: '2025-01-01T10:00:00Z', end: '2025-01-01T11:00:00Z' };
      mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
      mockFindEventsInTimeRange.mockResolvedValue([{ summary: 'Existing Event', start: { dateTime: '2025-01-01T10:30:00Z' } }]);
      
      await processCompleteEvent(replyToken, event as any, userId);

      expect(mockRedisSet).toHaveBeenCalledWith(userId, expect.stringContaining('awaiting_conflict_confirmation'), 'EX', 3600);
      expect(mockPushMessage).toHaveBeenCalledWith(userId, expect.objectContaining({
        template: expect.objectContaining({
          title: '⚠️ 時間衝突',
          text: expect.stringContaining('與現有活動時間重疊'),
        })
      }));
    });
  });

  describe('formatEventTime', () => {
    const { formatEventTime } = require('./index');
    it('should format multi-day all-day event', () => {
      const event = {
        start: '2025-01-01T00:00:00+08:00',
        end: '2025-01-03T00:00:00+08:00', // 2 full days
        allDay: true,
      };
      const result = formatEventTime(event);
      expect(result).toContain('2025/01/01 至 2025/01/02');
    });
  });
});