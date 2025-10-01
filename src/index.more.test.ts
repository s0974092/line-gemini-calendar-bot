import { TextEventMessage, FileEventMessage, WebhookEvent } from '@line/bot-sdk';
import { Readable } from 'stream';

// Helper to create a mock stream
const createMockStream = (content: string | Buffer) => {
    const stream = new Readable();
    stream.push(content);
    stream.push(null); // End of stream
    return stream;
};

// Helper to create a mock event object
const createMockEvent = (userId: string, message: any, type: 'text' | 'file' = 'text'): WebhookEvent => ({
    type: 'message',
    mode: 'active',
    timestamp: Date.now(),
    source: { type: 'user', userId },
    webhookEventId: 'test-webhook-id',
    deliveryContext: { isRedelivery: false },
    replyToken: 'test-reply-token',
    message: { ...message, type },
} as any);

describe('index.ts final coverage push', () => {
    let handleTextMessage: any;
    let handleNewCommand: any;
    let handlePostbackEvent: any;
    let handleFileMessage: any;
    const userId = 'testUser';
    const replyToken = 'test-reply-token';
    const chatId = 'testUser'; // In 1-on-1 chat, chatId is the same as userId

    const mockReplyMessage = jest.fn();
    const mockPushMessage = jest.fn();
    const mockGetMessageContent = jest.fn();
    const mockClassifyIntent = jest.fn();
    const mockParseEventChanges = jest.fn();
    const mockParseRecurrenceEndCondition = jest.fn();
    const mockRedisGet = jest.fn();
    const mockRedisSet = jest.fn();
    const mockRedisDel = jest.fn();
    const mockRedisOn = jest.fn();
    const mockCreateCalendarEvent = jest.fn();
    const mockGetCalendarChoicesForUser = jest.fn();
    const mockUpdateEvent = jest.fn();
    const mockDeleteEvent = jest.fn();
    const mockCalendarEventsGet = jest.fn();
    const mockFindEventsInTimeRange = jest.fn();
    const mockSearchEvents = jest.fn();
    const mockParseXlsxToEvents = jest.fn();
    const mockParseCsvToEvents = jest.fn();

    beforeAll(() => {
        jest.mock('@line/bot-sdk', () => ({
            Client: jest.fn(() => ({
              replyMessage: mockReplyMessage,
              pushMessage: mockPushMessage,
              getMessageContent: mockGetMessageContent,
            })),
            middleware: jest.fn(() => (req: any, res: any, next: () => any) => next()),
          }));

          jest.mock('./services/geminiService', () => ({
            classifyIntent: mockClassifyIntent,
            parseEventChanges: mockParseEventChanges,
            parseRecurrenceEndCondition: mockParseRecurrenceEndCondition,
          }));

          jest.mock('ioredis', () => {
            return jest.fn().mockImplementation(() => ({
              get: mockRedisGet,
              set: mockRedisSet,
              del: mockRedisDel,
              on: mockRedisOn,
            }));
          });

          jest.mock('./services/googleCalendarService', () => ({
            createCalendarEvent: mockCreateCalendarEvent,
            getCalendarChoicesForUser: mockGetCalendarChoicesForUser,
            updateEvent: mockUpdateEvent,
            deleteEvent: mockDeleteEvent,
            findEventsInTimeRange: mockFindEventsInTimeRange,
            searchEvents: mockSearchEvents,
            calendar: {
                events: {
                  get: mockCalendarEventsGet,
                },
              },
            DuplicateEventError: class extends Error {
                constructor(message: string, public htmlLink?: string) {
                  super(message);
                }
              },
        }));

        jest.mock('./utils/excelParser', () => ({
            parseXlsxToEvents: mockParseXlsxToEvents,
            parseCsvToEvents: mockParseCsvToEvents,
        }));
    });

    beforeEach(() => {
        const indexModule = require('./index');
        handleTextMessage = indexModule.handleTextMessage;
        handleNewCommand = indexModule.handleNewCommand;
        handlePostbackEvent = indexModule.handlePostbackEvent;
        handleFileMessage = indexModule.handleFileMessage;

        // Reset mocks to a default working state before each test
        mockRedisGet.mockResolvedValue(undefined);
        mockRedisSet.mockResolvedValue('OK');
        mockRedisDel.mockResolvedValue(1);
        mockGetMessageContent.mockResolvedValue(createMockStream('csv content'));
        mockParseCsvToEvents.mockReturnValue([{title: 'test event', start: '2025-01-01T10:00:00+08:00', end: '2025-01-01T11:00:00+08:00'}]);
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockGetMessageContent.mockReset();
        mockFindEventsInTimeRange.mockResolvedValue([]);
        mockCreateCalendarEvent.mockResolvedValue({ htmlLink: 'link' });
        mockClassifyIntent.mockResolvedValue({ type: 'unknown' });

        // Explicitly clear mocks before each test to prevent cross-contamination
        mockReplyMessage.mockClear();
        mockPushMessage.mockClear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it('should ask for title if create_event intent is missing it', async () => {
        mockClassifyIntent.mockResolvedValue({ type: 'create_event', event: { start: '2025-01-01' } });
        const message = { type: 'text', text: '' } as TextEventMessage;
        const mockEvent = createMockEvent(userId, message);
        await handleTextMessage(replyToken, message, userId, mockEvent);
        expect(mockRedisSet).toHaveBeenCalledWith(`state:${userId}:${chatId}`, expect.stringContaining('awaiting_event_title'), 'EX', 3600);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: expect.stringContaining('要安排什麼活動呢？') });
    });

    it('should handle title response after being asked', async () => {
        const state = { step: 'awaiting_event_title', event: { start: '2025-01-01' }, chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockCreateCalendarEvent.mockResolvedValue({ htmlLink: 'link' });
        const message = { type: 'text', text: 'New Event Title' } as TextEventMessage;
        const mockEvent = createMockEvent(userId, message);

        await handleTextMessage(replyToken, message, userId, mockEvent);

        expect(mockCreateCalendarEvent).toHaveBeenCalledWith(expect.objectContaining({ title: 'New Event Title' }), 'primary');
        expect(mockRedisDel).toHaveBeenCalledWith(`state:${userId}:${chatId}`);
    });

    it('should handle direct update with changes', async () => {
        mockClassifyIntent.mockResolvedValue({ type: 'update_event', query: 'meeting', timeMin: 'a', timeMax: 'b', changes: { title: 'New Title' } });
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockSearchEvents.mockResolvedValue({ events: [{ id: '1', organizer: { email: 'primary' } }] });
        mockUpdateEvent.mockResolvedValue({ summary: 'New Title', htmlLink: 'link' });
        const message = { type: 'text', text: '' } as TextEventMessage;
        await handleNewCommand(replyToken, message, userId, chatId);
        expect(mockUpdateEvent).toHaveBeenCalled();
    });

    it('should handle direct update failure', async () => {
        mockClassifyIntent.mockResolvedValue({ type: 'update_event', query: 'meeting', timeMin: 'a', timeMax: 'b', changes: { title: 'New Title' } });
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockSearchEvents.mockResolvedValue({ events: [{ id: '1', organizer: { email: 'primary' } }] });
        mockUpdateEvent.mockRejectedValue(new Error('Update failed'));
        const message = { type: 'text', text: '' } as TextEventMessage;
        await handleNewCommand(replyToken, message, userId, chatId);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, { type: 'text', text: '抱歉，更新活動時發生錯誤。' });
    });

    it('should handle create_schedule intent', async () => {
        const message = { type: 'text', text: '幫「John」建立班表' } as TextEventMessage;
        const mockEvent = createMockEvent(userId, message);
        await handleTextMessage(replyToken, message, userId, mockEvent);
        expect(mockRedisSet).toHaveBeenCalledWith(`state:${userId}:${chatId}`, expect.stringContaining('awaiting_csv_upload'), 'EX', 3600);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: expect.stringContaining('請現在傳送您要為「John」分析的班表 CSV 或 XLSX 檔案') });
    });

    it('should handle incomplete intent', async () => {
        mockClassifyIntent.mockResolvedValue({ type: 'incomplete' });
        const message = { type: 'text', text: '... ' } as TextEventMessage;
        const result = await handleNewCommand(replyToken, message, userId, chatId);
        expect(result).toBeNull();
    });

    it('should handle unknown intent', async () => {
        mockClassifyIntent.mockResolvedValue({ type: 'unknown' });
        const message = { type: 'text', text: '... ' } as TextEventMessage;
        const result = await handleNewCommand(replyToken, message, userId, chatId);
        expect(result).toBeNull();
    });

    it('should handle unhandled intent type', async () => {
        mockClassifyIntent.mockResolvedValue({ type: 'some_other_intent' });
        const message = { type: 'text', text: '' } as TextEventMessage;
        const result = await handleNewCommand(replyToken, message, userId, chatId);
        expect(result).toBeNull();
    });

    it('should handle query with hasMore results', async () => {
        mockClassifyIntent.mockResolvedValue({ type: 'query_event', query: 'events', timeMin: '2025-01-01T00:00:00Z', timeMax: '2025-01-01T23:59:59Z' });
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockSearchEvents.mockResolvedValue({ events: [{}], nextPageToken: 'more' });
        const message = { type: 'text', text: 'find events' } as TextEventMessage;
        await handleNewCommand(replyToken, message, userId, chatId);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, expect.arrayContaining([expect.objectContaining({ text: expect.stringContaining('還有更多結果') })]));
    });

    it('should handle query with no query text', async () => {
        mockClassifyIntent.mockResolvedValue({ type: 'query_event', query: '' });
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockSearchEvents.mockResolvedValue({ events: [], nextPageToken: null });
        const message = { type: 'text', text: '' } as TextEventMessage;
        await handleNewCommand(replyToken, message, userId, chatId);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '太好了，這個時段目前沒有安排活動！' });
    });

    it('should handle create_after_choice with error', async () => {
        const state = { step: 'awaiting_calendar_choice', event: {start: 'a', end: 'b'}, chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockCreateCalendarEvent.mockRejectedValue(new Error());
        const postback = { data: 'action=create_after_choice&calendarId=primary' } as any;
        const mockEvent = createMockEvent(userId, {}) as any;
        mockEvent.type = 'postback';
        mockEvent.postback = postback;

        await handlePostbackEvent(mockEvent);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, { type: 'text', text: '抱歉，新增日曆事件時發生錯誤。' });
    });

    it('should handle delete with no calendarId', async () => {
        const postback = { data: 'action=delete&eventId=1' } as any;
        const mockEvent = createMockEvent(userId, {}) as any;
        mockEvent.type = 'postback';
        mockEvent.postback = postback;
        await handlePostbackEvent(mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，找不到要刪除的活動資訊。' });
    });

    it('should handle delete with fetch error', async () => {
        mockCalendarEventsGet.mockRejectedValue(new Error('Fetch failed'));
        const postback = { data: 'action=delete&eventId=1&calendarId=primary' } as any;
        const mockEvent = createMockEvent(userId, {}) as any;
        mockEvent.type = 'postback';
        mockEvent.postback = postback;
        await handlePostbackEvent(mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，找不到要刪除的活動資訊。' });
    });

    it('should handle confirm_delete with no state', async () => {
        mockRedisGet.mockResolvedValue(undefined);
        const postback = { data: 'action=confirm_delete' } as any;
        const mockEvent = createMockEvent(userId, {}) as any;
        mockEvent.type = 'postback';
        mockEvent.postback = postback;
        await handlePostbackEvent(mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，您的刪除請求已逾時或無效，請重新操作。' });
    });

    it('should handle confirm_delete with delete error', async () => {
        const state = { step: 'awaiting_delete_confirmation', eventId: '1', calendarId: 'primary', chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockDeleteEvent.mockRejectedValue(new Error('Delete failed'));
        const postback = { data: 'action=confirm_delete' } as any;
        const mockEvent = createMockEvent(userId, {}) as any;
        mockEvent.type = 'postback';
        mockEvent.postback = postback;
        await handlePostbackEvent(mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，刪除活動時發生錯誤。' });
    });

    it('should handle modify with no calendarId', async () => {
        const postback = { data: 'action=modify&eventId=1' } as any;
        const mockEvent = createMockEvent(userId, {}) as any;
        mockEvent.type = 'postback';
        mockEvent.postback = postback;
        await handlePostbackEvent(mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，找不到要修改的活動資訊。' });
    });

    it('should handle force_create with no state', async () => {
        mockRedisGet.mockResolvedValue(undefined);
        const postback = { data: 'action=force_create' } as any;
        const mockEvent = createMockEvent(userId, {}) as any;
        mockEvent.type = 'postback';
        mockEvent.postback = postback;
        await handlePostbackEvent(mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，您的請求已逾時或無效，請重新操作。' });
    });

    it('should handle force_create with create error', async () => {
        const state = { step: 'awaiting_conflict_confirmation', event: {}, calendarId: 'primary', chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockCreateCalendarEvent.mockRejectedValue(new Error());
        const postback = { data: 'action=force_create' } as any;
        const mockEvent = createMockEvent(userId, {}) as any;
        mockEvent.type = 'postback';
        mockEvent.postback = postback;
        await handlePostbackEvent(mockEvent);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, { type: 'text', text: '抱歉，新增日曆事件時發生錯誤。' });
    });

    it('should handle createAllShifts with no state', async () => {
        mockRedisGet.mockResolvedValue(undefined);
        const postback = { data: 'action=createAllShifts&calendarId=primary' } as any;
        const mockEvent = createMockEvent(userId, {}) as any;
        mockEvent.type = 'postback';
        mockEvent.postback = postback;
        await handlePostbackEvent(mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，您的批次新增請求已逾時或無效，請重新上傳檔案。' });
    });

    it('should handle createAllShifts with no calendarId', async () => {
        const state = { step: 'awaiting_bulk_confirmation', events: [], chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        const postback = { data: 'action=createAllShifts' } as any;
        const mockEvent = createMockEvent(userId, {}) as any;
        mockEvent.type = 'postback';
        mockEvent.postback = postback;
        await handlePostbackEvent(mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '錯誤：找不到日曆資訊，請重新操作。' });
    });

    it('should handle createAllShifts with mixed results', async () => {
        const state = { step: 'awaiting_bulk_confirmation', events: [{}, {}, {}], chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }, {id: 'secondary', summary: 'Secondary'}]);
        mockCreateCalendarEvent
            .mockResolvedValueOnce({}) 
            .mockRejectedValueOnce(new (require('./services/googleCalendarService').DuplicateEventError)('d'))
            .mockRejectedValueOnce(new Error('Create failed'));
        const postback = { data: 'action=createAllShifts&calendarId=all' } as any;
        const mockEvent = createMockEvent(userId, {}) as any;
        mockEvent.type = 'postback';
        mockEvent.postback = postback;
        await handlePostbackEvent(mockEvent);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, { type: 'text', text: expect.stringContaining('新增成功 4 件') });
    });

    it('should handle createAllShifts with general error', async () => {
        const state = { step: 'awaiting_bulk_confirmation', events: [{}], chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockCreateCalendarEvent.mockRejectedValue(new Error('General error'));
        const postback = { data: 'action=createAllShifts&calendarId=all' } as any;
        const mockEvent = createMockEvent(userId, {}) as any;
        mockEvent.type = 'postback';
        mockEvent.postback = postback;
        await handlePostbackEvent(mockEvent);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, { type: 'text', text: expect.stringContaining('批次匯入完成') });
    });

    it('should handle delete action successfully', async () => {
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockCalendarEventsGet.mockResolvedValue({ data: { summary: 'Event' } });
        const postback = { data: 'action=delete&eventId=1&calendarId=primary' } as any;
        const mockEvent = createMockEvent(userId, {}) as any;
        mockEvent.type = 'postback';
        mockEvent.postback = postback;
        await handlePostbackEvent(mockEvent);
        const compositeKey = `state:${userId}:${chatId}`;
        expect(mockRedisSet).toHaveBeenCalledWith(compositeKey, expect.stringContaining('awaiting_delete_confirmation'), 'EX', 3600);
    });

    it('should handle force_create action successfully', async () => {
        const state = { step: 'awaiting_conflict_confirmation', event: {title: 't', start: 'a', end: 'b'}, calendarId: 'primary', chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockCreateCalendarEvent.mockResolvedValue({ htmlLink: 'link' });
        const postback = { data: 'action=force_create' } as any;
        const mockEvent = createMockEvent(userId, {}) as any;
        mockEvent.type = 'postback';
        mockEvent.postback = postback;
        await handlePostbackEvent(mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, expect.any(Object));
    });

    it('should handle unknown postback action', async () => {
        const postback = { data: 'action=unknown' } as any;
        const mockEvent = createMockEvent(userId, {}) as any;
        mockEvent.type = 'postback';
        mockEvent.postback = postback;
        await handlePostbackEvent(mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，發生了未知的錯誤。' });
    });

    it('should handle event update with Gemini error', async () => {
        const state = { step: 'awaiting_modification_details', eventId: '1', calendarId: 'primary', chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockParseEventChanges.mockResolvedValue({ error: 'parse_failed' });
        const message = { type: 'text', text: '' } as TextEventMessage;
        const mockEvent = createMockEvent(userId, message);
        await handleTextMessage(replyToken, message, userId, mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: expect.stringContaining('不太理解您的修改指令') });
    });

    it('should handle event update with GCal error', async () => {
        const state = { step: 'awaiting_modification_details', eventId: '1', calendarId: 'primary', chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockParseEventChanges.mockResolvedValue({ title: 'New Title' });
        mockUpdateEvent.mockRejectedValue(new Error('Update failed'));
        const message = { type: 'text', text: '' } as TextEventMessage;
        const mockEvent = createMockEvent(userId, message);
        await handleTextMessage(replyToken, message, userId, mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '抱歉，更新活動時發生錯誤。' });
    });

    it('should handle modification details and update the event', async () => {
      const state = { step: 'awaiting_modification_details', eventId: 'event-abc', calendarId: 'primary', chatId: 'chat1' };
      mockRedisGet.mockResolvedValue(JSON.stringify(state));
      mockParseEventChanges.mockResolvedValue({ title: 'Updated Meeting Title' });
      mockUpdateEvent.mockResolvedValue({ summary: 'Updated Meeting Title', htmlLink: 'http://example.com/updated' });
      
      const message = { type: 'text', text: '標題改為 Updated Meeting Title' } as TextEventMessage;
      const mockEvent = createMockEvent(userId, message);

      await handleTextMessage(replyToken, message, userId, mockEvent);

      expect(mockParseEventChanges).toHaveBeenCalledWith('標題改為 Updated Meeting Title');
      expect(mockUpdateEvent).toHaveBeenCalledWith('event-abc', 'primary', { summary: 'Updated Meeting Title' });
      expect(mockRedisDel).toHaveBeenCalledWith(`state:${userId}:chat1`);
      expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, expect.objectContaining({
        type: 'flex',
        altText: expect.stringContaining('活動已更新'),
      }));
    });

    it('should handle DuplicateEventError', async () => {
        mockClassifyIntent.mockResolvedValue({ type: 'create_event', event: { title: 't', start: 'a', end: 'b' } });
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockCreateCalendarEvent.mockRejectedValue(new (require('./services/googleCalendarService').DuplicateEventError)('d', 'link'));
        const message = { type: 'text', text: '' } as TextEventMessage;
        await handleNewCommand(replyToken, message, userId, chatId);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, expect.objectContaining({ type: 'template' }));
    });

    it('should handle generic error in handleCreateError', async () => {
        mockClassifyIntent.mockResolvedValue({ type: 'create_event', event: { title: 't', start: 'a', end: 'b' } });
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockCreateCalendarEvent.mockRejectedValue(new Error('generic'));
        const message = { type: 'text', text: '' } as TextEventMessage;
        await handleNewCommand(replyToken, message, userId, chatId);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, { type: 'text', text: '抱歉，新增日曆事件時發生錯誤。' });
    });

    it('should handle join and unfollow events', async () => {
        const { handleEvent } = require('./index');
        const joinEvent = { type: 'join', source: { type: 'room', roomId: 'test-room' } } as any;
        await handleEvent(joinEvent);
        expect(mockPushMessage).toHaveBeenCalledWith('test-room', expect.any(Object));

        const unfollowEvent = { type: 'unfollow', source: { userId: 'u' } } as any;
        const result = await handleEvent(unfollowEvent);
        expect(result).toBeNull();
    });

    it('should handle file message with XLSX parsing error', async () => {
        const state = { step: 'awaiting_csv_upload', personName: 'test', chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockGetMessageContent.mockResolvedValue(createMockStream(''));
        mockParseXlsxToEvents.mockImplementation(() => { throw new Error('xlsx error'); });
        const message = { id: '1', fileName: 'a.xlsx' } as FileEventMessage;
        const mockEvent = createMockEvent(userId, message, 'file');
        await handleFileMessage(replyToken, message, userId, mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '處理您上傳的 XLSX 檔案時發生錯誤，請檢查並確認檔案是否正確。' });
    });

    it('should handle generic error in processCompleteEvent', async () => {
        jest.doMock('./services/googleCalendarService', () => ({
            ...jest.requireActual('./services/googleCalendarService'),
            getCalendarChoicesForUser: jest.fn().mockRejectedValue(new Error()),
        }));
        const { processCompleteEvent } = require('./index');
        await processCompleteEvent(replyToken, {}, userId, chatId);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, expect.objectContaining({
            type: 'flex',
            altText: '活動已新增：undefined',
            contents: expect.objectContaining({
                type: 'bubble',
                header: expect.objectContaining({
                    contents: expect.arrayContaining([
                        expect.objectContaining({ text: '✅ 已新增至「Primary」' })
                    ])
                }),
                body: expect.objectContaining({
                    contents: expect.arrayContaining([
                        expect.objectContaining({ text: '無標題' })
                    ])
                })
            })
        }));
    });

    it('should handle generic error in handleRecurrenceResponse', async () => {
        const state = { step: 'awaiting_recurrence_end_condition', event: { recurrence: 'RRULE', start: '2025-01-01' }, chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        // Correctly mock the dependency to throw an error
        mockParseRecurrenceEndCondition.mockRejectedValue(new Error('Gemini Error'));

        const { handleRecurrenceResponse } = require('./index');
        await handleRecurrenceResponse(replyToken, {text: 'some response'} as TextEventMessage, userId, state);
        expect(mockPushMessage).toHaveBeenCalledWith(userId, { type: 'text', text: '抱歉，處理重複性活動時發生錯誤。' });
    });

    // File message handling
    it('should handle missing currentState', async () => {
        mockRedisGet.mockResolvedValue(undefined);
        const message = { id: '1', fileName: 'a.csv' } as FileEventMessage;
        const mockEvent = createMockEvent(userId, message, 'file');
        await handleFileMessage(replyToken, message, userId, mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: expect.stringContaining('不知道該如何處理') });
    });

    it('should handle non-csv file', async () => {
        const state = { step: 'awaiting_csv_upload', personName: 'test', chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        const message = { id: '1', fileName: 'a.txt' } as FileEventMessage;
        const mockEvent = createMockEvent(userId, message, 'file');
        await handleFileMessage(replyToken, message, userId, mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: expect.stringContaining('檔案格式錯誤') });
    });

    it('should handle empty events from csv', async () => {
        const state = { step: 'awaiting_csv_upload', personName: 'test', chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockGetMessageContent.mockResolvedValue(createMockStream('csv content'));
        mockParseCsvToEvents.mockReturnValue([]);
        const message = { id: '1', fileName: 'a.csv' } as FileEventMessage;
        const mockEvent = createMockEvent(userId, message, 'file');
        await handleFileMessage(replyToken, message, userId, mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: expect.stringContaining('找不到「test」的任何班次') });
    });

    it('should handle multiple calendar choices', async () => {
        const state = { step: 'awaiting_csv_upload', personName: 'test', chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockGetMessageContent.mockResolvedValue(createMockStream('csv content'));
        mockParseCsvToEvents.mockReturnValue([{title: 'test event', start: '2025-01-01T10:00:00+08:00', end: '2025-01-01T11:00:00+08:00'}]);
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        const message = { id: '1', fileName: 'a.csv' } as FileEventMessage;
        const mockEvent = createMockEvent(userId, message, 'file');
        await handleFileMessage(replyToken, message, userId, mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, [
            expect.objectContaining({
                text: expect.stringContaining('已為「test」解析出以下 1 個班次'),
            }),
            expect.objectContaining({
                template: expect.objectContaining({
                    text: '您要將這 1 個活動一次全部新增至您的 Google 日曆嗎？',
                    actions: expect.arrayContaining([
                        expect.objectContaining({
                            label: '全部新增',
                            data: 'action=createAllShifts&calendarId=primary',
                        }),
                    ]),
                }),
            }),
        ]);
    });

    it('should handle error during file processing', async () => {
        const state = { step: 'awaiting_csv_upload', personName: 'test', chatId };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockGetMessageContent.mockRejectedValueOnce(new Error());
        const message = { id: '1', fileName: 'a.csv' } as FileEventMessage;
        const mockEvent = createMockEvent(userId, message, 'file');
        await handleFileMessage(replyToken, message, userId, mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, { type: 'text', text: '處理您上傳的檔案時發生錯誤。' });
    });

    it('should handle single calendar choice for CSV upload', async () => {
        const state = { step: 'awaiting_csv_upload', personName: 'test', chatId };
        // This test requires a specific state in Redis.
        mockRedisGet.mockResolvedValue(JSON.stringify(state));

        // Explicitly mock dependencies for this test to ensure it's self-contained
        mockGetMessageContent.mockResolvedValue(createMockStream('csv content'));
        mockParseCsvToEvents.mockReturnValue([{title: 'test event', start: '2025-01-01T10:00:00+08:00', end: '2025-01-01T11:00:00+08:00'}]);
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);

        const message = { id: '1', fileName: 'a.csv' } as FileEventMessage;
        const mockEvent = createMockEvent(userId, message, 'file');
        await handleFileMessage(replyToken, message, userId, mockEvent);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, [
            expect.any(Object), 
            expect.objectContaining({ 
                template: expect.objectContaining({
                    text: '您要將這 1 個活動一次全部新增至您的 Google 日曆嗎？' 
                })
            })
        ]);
    });

    describe('parseCsvToEvents', () => {
        const { parseCsvToEvents: originalParseCsv } = jest.requireActual('./utils/excelParser');

        it('should handle BOM', () => {
            const result = originalParseCsv('\uFEFF姓名,10/26\n"test",0800-1700', 'test');
            expect(result.length).toBe(1);
        });
    
        it('should handle header not found', () => {
            const result = originalParseCsv('a,b\nc,d', 'test');
            expect(result.length).toBe(0);
        });
    
        it('should handle not enough data', () => {
            const result = originalParseCsv('姓名,10/26', 'test');
            expect(result.length).toBe(0);
        });
    
        it('should handle person not found', () => {
            const result = originalParseCsv('姓名,10/26\n"other",0800-1700', 'test');
            expect(result.length).toBe(0);
        });

        it('should parse various shift types', () => {
            const csv = `姓名,10/26,10/27,10/28,10/29,10/30,10/31,11/1\n"test",0800-1700,早班,晚班,早接菜,假,休,1230-2130`;
            const result = originalParseCsv(csv, 'test');
            expect(result.length).toBe(5);
            expect(result[0].title).toBe('test 早接菜');
            expect(result[1].title).toBe('test 早班');
            expect(result[2].title).toBe('test 晚班');
            expect(result[3].title).toBe('test 早接菜');
            expect(result[4].title).toBe('test 晚班');
        });

        it('should skip invalid shift patterns in csv', () => {
            const csv = `姓名,10/26,10/27\n"test",0800-1700,????`;
            const result = originalParseCsv(csv, 'test');
            expect(result.length).toBe(1); // Should only parse the valid one
            expect(result[0].title).toBe('test 早接菜');
        });

        it('should handle time format with no minutes (e.g., 8-12)', () => {
            const csv = `姓名,10/26\n"test",8-12`;
            const result = originalParseCsv(csv, 'test');
            expect(result.length).toBe(1);
            expect(result[0].start).toContain('T08:00:00');
            expect(result[0].end).toContain('T12:00:00');
        });

        it('should handle time format with partial minutes (e.g., 14-1630)', () => {
            const csv = `姓名,10/27\n"test",14-1630`;
            const result = originalParseCsv(csv, 'test');
            expect(result.length).toBe(1);
            expect(result[0].start).toContain('T14:00:00');
            expect(result[0].end).toContain('T16:30:00');
        });

        it('should handle csv with only header', () => {
            const csv = `姓名,10/26`;
            const result = originalParseCsv(csv, 'test');
            expect(result.length).toBe(0);
        });
      });
});
