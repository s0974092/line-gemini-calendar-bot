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
    quit: jest.fn((callback) => callback()),
  }));
});


describe('index.ts unit tests', () => {
  afterAll((done) => {
    const indexModule = require('./index');
    if (indexModule.server) {
      indexModule.server.close(() => {
        indexModule.redis.quit(done);
      });
    } else {
      indexModule.redis.quit(done);
    }
  });
  afterEach(() => {
    jest.resetModules();
  });

  describe('Redis Error Handling', () => {
    it('should log an error when redis connection fails', () => {
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
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
});
