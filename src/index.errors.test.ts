import { FileEventMessage } from '@line/bot-sdk';
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
  middleware: jest.fn(() => (req: any, res: any, next: any) => next()),
}));

const mockParseEventChanges = jest.fn();
jest.mock('./services/geminiService', () => ({
    parseEventChanges: mockParseEventChanges,
}));

const mockCreateCalendarEvent = jest.fn();
const mockGetCalendarChoicesForUser = jest.fn();
const mockFindEventsInTimeRange = jest.fn();
const mockUpdateEvent = jest.fn();
jest.mock('./services/googleCalendarService', () => ({
  createCalendarEvent: mockCreateCalendarEvent,
  getCalendarChoicesForUser: mockGetCalendarChoicesForUser,
  findEventsInTimeRange: mockFindEventsInTimeRange,
  updateEvent: mockUpdateEvent,
  DuplicateEventError: class extends Error {
    public htmlLink?: string | null;
    constructor(message: string, htmlLink?: string | null) {
      super(message);
      this.name = 'DuplicateEventError';
      this.htmlLink = htmlLink;
    }
  },
}));

const mockRedisGet = jest.fn();
const mockRedisSet = jest.fn();
const mockRedisDel = jest.fn();
const mockRedisOn = jest.fn(); // <-- THE FIX

jest.mock('ioredis', () => {
  return jest.fn().mockImplementation(() => ({
    get: mockRedisGet,
    set: mockRedisSet,
    del: mockRedisDel,
    on: mockRedisOn, // <-- THE FIX
  }));
});

describe('Error Handling Scenarios', () => {
    let processCompleteEvent: any;
    let handleEventUpdate: any;
    let handleFileMessage: any;
  
    beforeEach(() => {
      jest.resetModules();
      const indexModule = require('./index');
      processCompleteEvent = indexModule.processCompleteEvent;
      handleEventUpdate = indexModule.handleEventUpdate;
      handleFileMessage = indexModule.handleFileMessage;
    });
  
    afterEach(() => {
      jest.clearAllMocks();
    });
  
    describe('in processCompleteEvent', () => {
      const testEvent: CalendarEvent = {
        title: 'Test Event',
        start: '2025-01-01T10:00:00+08:00',
        end: '2025-01-01T11:00:00+08:00',
        allDay: false,
        recurrence: null,
        reminder: 30,
        calendarId: 'primary',
      };
      const userId = 'test-user';
      const replyToken = 'test-reply-token';
  
      it('should send a generic error message via pushMessage when createCalendarEvent throws a generic Error', async () => {
        const genericError = new Error('Something went wrong with the API');
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockFindEventsInTimeRange.mockResolvedValue([]);
        mockCreateCalendarEvent.mockRejectedValue(genericError);
  
        await processCompleteEvent(replyToken, testEvent, userId);
  
        expect(mockCreateCalendarEvent).toHaveBeenCalledWith(testEvent, 'primary');
        expect(mockPushMessage).toHaveBeenCalledWith(userId, {
          type: 'text',
          text: '抱歉，新增日曆事件時發生錯誤。',
        });
      });
  
      it('should send a specific message via pushMessage when createCalendarEvent throws a DuplicateEventError', async () => {
        const { DuplicateEventError } = require('./services/googleCalendarService');
        const duplicateError = new DuplicateEventError('Event already exists', 'http://google.com/calendar/event-link');
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'Primary' }]);
        mockFindEventsInTimeRange.mockResolvedValue([]);
        mockCreateCalendarEvent.mockRejectedValue(duplicateError);
  
        await processCompleteEvent(replyToken, testEvent, userId);
  
        expect(mockCreateCalendarEvent).toHaveBeenCalledWith(testEvent, 'primary');
        expect(mockPushMessage).toHaveBeenCalledWith(userId, {
          type: 'template',
          altText: '活動已存在',
          template: {
            type: 'buttons',
            title: '🔍 活動已存在',
            text: '這個活動先前已經在日曆中囉！',
            actions: [{
              type: 'uri',
              label: '點擊查看',
              uri: 'http://google.com/calendar/event-link'
            }]
          }
        });
      });
    });
  
    describe('in handleEventUpdate', () => {
      const userId = 'test-user';
      const replyToken = 'test-reply-token';
      const currentState = {
        step: 'awaiting_modification_details',
        eventId: 'event-123',
        calendarId: 'cal-456',
        timestamp: Date.now(),
      };
      const message = { type: 'text', text: '時間改到明天下午三點' } as any;
  
      it('should send a generic error message when updateEvent throws an error', async () => {
        const genericError = new Error('API update failed');
        mockRedisGet.mockResolvedValue(JSON.stringify(currentState));
  
        mockParseEventChanges.mockResolvedValue({ start: '2025-01-02T15:00:00+08:00', end: '2025-01-02T16:00:00+08:00' });
        mockUpdateEvent.mockRejectedValue(genericError);
  
        await handleEventUpdate(replyToken, message, userId, currentState);
  
        expect(mockUpdateEvent).toHaveBeenCalled();
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, {
          type: 'text',
          text: '抱歉，更新活動時發生錯誤。',
        });
      });
    });

    describe('in handleFileMessage', () => {
        it('should handle error when getMessageContent fails', async () => {
            const userId = 'file-error-user';
            const replyToken = 'reply-token-file-error';
            const message = { id: '12345', fileName: 'test.csv' } as FileEventMessage;
            const currentState = { step: 'awaiting_csv_upload', personName: 'test' };
    
            mockRedisGet.mockResolvedValue(JSON.stringify(currentState));
            mockGetMessageContent.mockRejectedValue(new Error('Download failed'));
    
            await handleFileMessage(replyToken, message, userId);
    
            expect(mockRedisDel).toHaveBeenCalledWith(userId);
            expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, {
                type: 'text',
                text: '處理您上傳的 CSV 檔案時發生錯誤。'
            });
        });
      });
  });
  