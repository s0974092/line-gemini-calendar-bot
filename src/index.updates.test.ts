import { MessageEvent, TextEventMessage } from '@line/bot-sdk';

// =================================================================================
// MOCKS
// =================================================================================
const mockReplyMessage = jest.fn();
const mockPushMessage = jest.fn();
const mockClassifyIntent = jest.fn();
const mockParseEventChanges = jest.fn();
const mockSearchEvents = jest.fn();
const mockUpdateEvent = jest.fn();
const mockGetCalendarChoicesForUser = jest.fn();
const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();

jest.mock('@line/bot-sdk', () => ({
    Client: jest.fn(() => ({
        replyMessage: (token: any, msg: any) => mockReplyMessage(token, msg),
        pushMessage: (id: any, msg: any) => mockPushMessage(id, msg),
        getMessageContent: jest.fn(),
    })),
    middleware: jest.fn(() => (req: any, res: any, next: () => any) => next()),
}));

jest.mock('./services/geminiService', () => ({
    classifyIntent: (text: string) => mockClassifyIntent(text),
    parseEventChanges: (text: string) => mockParseEventChanges(text),
}));

jest.mock('./services/googleCalendarService', () => ({
    searchEvents: (...args: any[]) => mockSearchEvents(...args),
    updateEvent: (...args: any[]) => mockUpdateEvent(...args),
    getCalendarChoicesForUser: () => mockGetCalendarChoicesForUser(),
    calendar: {
        events: {
            get: jest.fn(),
        },
    },
}));

jest.mock('ioredis', () => {
    return jest.fn().mockImplementation(() => ({
        get: (key: string) => mockRedisGet(key),
        set: (...args: any[]) => mockRedisSet(...args),
        del: (key: string) => mockRedisDel(key),
        on: jest.fn(),
        quit: jest.fn().mockResolvedValue('OK'),
    }));
});

describe('Event Time Update Scenarios', () => {
    const userId = 'test-user';
    const replyToken = 'test-reply-token';
    let handleEvent: any;

    beforeAll(() => {
        process.env.USER_WHITELIST = userId;
        process.env.LINE_CHANNEL_SECRET = 'secret';
        process.env.LINE_CHANNEL_ACCESS_TOKEN = 'token';
        const indexModule = require('./index');
        handleEvent = indexModule.handleEvent;
    });

    beforeEach(() => {
        jest.clearAllMocks();
        mockRedisGet.mockResolvedValue(undefined);
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
    });

    const createMockTextMessageEvent = (text: string): MessageEvent => ({
        type: 'message',
        replyToken,
        source: { type: 'user', userId },
        message: { type: 'text', text, id: 'msg-123' } as TextEventMessage,
        mode: 'active',
        timestamp: Date.now(),
    } as any);

    it('Scenario 1: Timed -> Timed (Update to another time range)', async () => {
        const newStart = '2025-01-01T15:00:00+08:00';
        const newEnd = '2025-01-01T16:00:00+08:00';
        mockClassifyIntent.mockResolvedValue({
            type: 'update_event',
            query: '會議',
            timeMin: '2025-01-01T00:00:00+08:00',
            timeMax: '2025-01-01T23:59:59+08:00',
            changes: { start: newStart, end: newEnd },
        });

        const existingEvent = {
            id: 'event-1',
            summary: '原本的會議',
            organizer: { email: 'primary' },
            start: { dateTime: '2025-01-01T10:00:00+08:00' },
            end: { dateTime: '2025-01-01T11:00:00+08:00' },
        };
        mockSearchEvents.mockResolvedValue({ events: [existingEvent] });
        mockUpdateEvent.mockResolvedValue({
            summary: '原本的會議',
            start: { dateTime: newStart },
            end: { dateTime: newEnd },
            htmlLink: 'http://link',
        });

        await handleEvent(createMockTextMessageEvent('幫我把會議改到下午三點到四點'));
        expect(mockUpdateEvent).toHaveBeenCalledWith('event-1', 'primary', expect.objectContaining({
            start: { dateTime: newStart, date: null, timeZone: 'Asia/Taipei' },
            end: { dateTime: newEnd, date: null, timeZone: 'Asia/Taipei' },
        }));
    });

    it('Scenario 2: All-day -> All-day (Update to another date)', async () => {
        const newDate = '2025-01-02';
        mockClassifyIntent.mockResolvedValue({
            type: 'update_event',
            query: '休假',
            changes: { start: newDate, end: '2025-01-03' },
        });

        const existingEvent = {
            id: 'event-2',
            summary: '休假',
            organizer: { email: 'primary' },
            start: { date: '2025-01-01' },
        };
        mockSearchEvents.mockResolvedValue({ events: [existingEvent] });
        mockUpdateEvent.mockResolvedValue({ summary: '休假', start: { date: newDate }, htmlLink: 'http://link' });

        await handleEvent(createMockTextMessageEvent('把休假改到 1/2'));
        expect(mockUpdateEvent).toHaveBeenCalledWith('event-2', 'primary', expect.objectContaining({
            start: { date: newDate, dateTime: null },
            end: { date: '2025-01-03', dateTime: null },
        }));
    });

    it('Scenario 3: Timed -> All-day (Convert to all-day)', async () => {
        const newDate = '2025-01-02';
        mockClassifyIntent.mockResolvedValue({
            type: 'update_event',
            query: '會議',
            changes: { start: newDate, end: '2025-01-03' },
        });

        const existingEvent = {
            id: 'event-3',
            summary: '會議',
            organizer: { email: 'primary' },
            start: { dateTime: '2025-01-02T10:00:00+08:00' },
            end: { dateTime: '2025-01-02T11:00:00+08:00' },
        };
        mockSearchEvents.mockResolvedValue({ events: [existingEvent] });
        mockUpdateEvent.mockResolvedValue({ summary: '會議', start: { date: newDate }, htmlLink: 'http://link' });

        await handleEvent(createMockTextMessageEvent('把明天的會議改成整天'));
        expect(mockUpdateEvent).toHaveBeenCalledWith('event-3', 'primary', expect.objectContaining({
            start: { date: newDate, dateTime: null },
            end: { date: '2025-01-03', dateTime: null },
        }));
    });

    it('Scenario 4: All-day -> Timed (Convert to timed range)', async () => {
        const newStart = '2025-01-02T10:00:00+08:00';
        const newEnd = '2025-01-02T11:00:00+08:00';
        mockClassifyIntent.mockResolvedValue({
            type: 'update_event',
            query: '外訓',
            changes: { start: newStart, end: newEnd },
        });

        const existingEvent = {
            id: 'event-4',
            summary: '外訓',
            organizer: { email: 'primary' },
            start: { date: '2025-01-02' },
        };
        mockSearchEvents.mockResolvedValue({ events: [existingEvent] });
        mockUpdateEvent.mockResolvedValue({ summary: '外訓', start: { dateTime: newStart }, htmlLink: 'http://link' });

        await handleEvent(createMockTextMessageEvent('把外訓改成早上十點'));
        expect(mockUpdateEvent).toHaveBeenCalledWith('event-4', 'primary', expect.objectContaining({
            start: { dateTime: newStart, date: null, timeZone: 'Asia/Taipei' },
            end: { dateTime: newEnd, date: null, timeZone: 'Asia/Taipei' },
        }));
    });
});
