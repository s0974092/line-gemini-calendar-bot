// This file is structured to handle complex module-level mocking and environment variable testing.

// =================================================================================
// MOCKS - Setup is done once at the top
// =================================================================================
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
  parseTextToCalendarEvent: jest.fn(),
  parseImageToCalendarEvents: jest.fn(),
  translateRruleToHumanReadable: jest.fn(),
}));

const mockCreateCalendarEvent = jest.fn();
const mockGetCalendarChoicesForUser = jest.fn();
const mockDeleteEvent = jest.fn();
const mockCalendarEventsGet = jest.fn();
const mockFindEventsInTimeRange = jest.fn();
const mockSearchEvents = jest.fn();
const mockUpdateEvent = jest.fn();
const mockCalendarEventsList = jest.fn();

jest.mock('./services/googleCalendarService', () => {
  const { DuplicateEventError: ActualDuplicateEventError } = jest.requireActual('./services/googleCalendarService');
  return {
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
    DuplicateEventError: ActualDuplicateEventError,
  };
});

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
  }));
});

// =================================================================================
// TESTS START HERE
// =================================================================================

import { TextEventMessage, ImageEventMessage, PostbackEvent, Message, FileEventMessage, WebhookEvent } from '@line/bot-sdk';
import { calendar_v3 } from 'googleapis';
import { CalendarEvent } from './services/geminiService';

describe('index.ts functional tests', () => {
  const userId = 'testUser';
  const replyToken = 'testReplyToken';
  let index: any; // To hold the required module
  beforeEach(() => {
    jest.resetModules();
    // Mock environment variables
    process.env.USER_WHITELIST = userId;
    process.env.LINE_CHANNEL_SECRET = 'test-secret';
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';
    index = require('./index');
  });

  afterEach(async () => {
    const { redis, server } = require('./index');
    if (server && server.listening) {
      await new Promise(resolve => server.close(resolve));
    }
    await redis.quit();
    // Clean up mocks
    mockClassifyIntent.mockClear();
    mockGetCalendarChoicesForUser.mockClear();
    mockSearchEvents.mockClear();
    mockReplyMessage.mockClear();
    mockPushMessage.mockClear();
    mockRedisSet.mockClear();
    mockRedisGet.mockClear();
    mockRedisDel.mockClear();
    mockCreateCalendarEvent.mockClear();
    mockCalendarEventsList.mockClear();
  });

  describe('handleEvent', () => {
    it('should handle join event in a group', async () => {
      const event = { type: 'join', source: { type: 'group', groupId: 'test-group' } } as WebhookEvent;
      await index.handleEvent(event);
      expect(mockPushMessage).toHaveBeenCalledWith('test-group', expect.any(Object));
    });

    it('should handle unhandled event types', async () => {
      const consoleLogSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
      const event = { type: 'unfollow', source: { userId } } as WebhookEvent;
      await index.handleEvent(event);
      expect(consoleLogSpy).toHaveBeenCalledWith('Unhandled event type: unfollow');
      consoleLogSpy.mockRestore();
    });

    it('should handle events with no userId if not a join event', async () => {
        const event = { type: 'message', source: { type: 'group', groupId: 'g1' } } as any;
        const result = await index.handleEvent(event);
        expect(result).toBeNull();
    });
  });

  describe('handleQueryResults', () => {
    it('should correctly format a carousel of events', async () => {
      const events: calendar_v3.Schema$Event[] = [
        {
          summary: 'Event 1 Title',
          start: { dateTime: '2025-01-01T10:00:00Z' },
          end: { dateTime: '2025-01-01T11:00:00Z' },
          organizer: { email: 'cal1@test.com' },
          id: 'ev1',
          htmlLink: 'link1',
        },
        {
          summary: 'Event 2 With A Very Long Title That Should Be Truncated',
          start: { date: '2025-01-02' },
          end: { date: '2025-01-03' },
          organizer: { email: 'cal2@test.com' },
          id: 'ev2',
          htmlLink: 'link2',
        },
        {
            summary: 'Event 3 No Link',
            start: { dateTime: '2025-01-03T10:00:00Z' },
            end: { dateTime: '2025-01-03T11:00:00Z' },
            organizer: { email: 'cal1@test.com' },
            id: 'ev3',
        }
      ];
      mockGetCalendarChoicesForUser.mockResolvedValue([
        { id: 'cal1@test.com', summary: 'Personal Calendar' },
        { id: 'cal2@test.com', summary: 'Work Calendar' },
      ]);

      await index.handleQueryResults(replyToken, 'My Query', events, true);

      const replyArgs = mockReplyMessage.mock.calls[0];
      const textMessage = replyArgs[1][0];
      const carouselMessage = replyArgs[1][1];
      
      expect(textMessage.text).toContain('為您找到 3 個與「My Query」相關的活動：');
      expect(textMessage.text).toContain('還有更多結果');

      expect(carouselMessage.type).toBe('flex');
      expect(carouselMessage.altText).toBe('為您找到 3 個活動');
      const carousel = carouselMessage.contents;
      expect(carousel.type).toBe('carousel');
      expect(carousel.contents.length).toBe(3);

      // Check bubble 1
      const bubble1 = carousel.contents[0];
      expect(bubble1.header.contents[0].text).toBe('日曆：Personal Calendar');
      expect(bubble1.body.contents[0].text).toBe('Event 1 Title');
      expect(bubble1.footer.contents.length).toBe(3);

      // Check bubble 2 (truncation)
      const bubble2 = carousel.contents[1];
      expect(bubble2.header.contents[0].text).toBe('日曆：Work Calendar');
      expect(bubble2.body.contents[0].text).toBe('Event 2 With A Very Long Title That Should Be Truncated');
      expect(bubble2.footer.contents.length).toBe(3);

      // Check bubble 3 (no link)
      const bubble3 = carousel.contents[2];
      expect(bubble3.footer.contents.length).toBe(2);
    });
  });

  describe('handleNewCommand', () => {
    it('should ask for confirmation when one event is found for deletion', async () => {
        const intent = { type: 'delete_event', query: 'Meeting', timeMin: 'a', timeMax: 'b' };
        mockClassifyIntent.mockResolvedValue(intent);
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary' }]);
        const eventToDelete = { id: 'event1', summary: 'The Meeting', organizer: { email: 'primary' } };
        mockSearchEvents.mockResolvedValue({ events: [eventToDelete] });

        const message = { type: 'text', text: 'delete the meeting' } as TextEventMessage;
        await index.handleNewCommand(replyToken, message, userId, userId);

        const [key, value, ex, expiry] = mockRedisSet.mock.calls[0];
        expect(key).toBe(`state:${userId}:${userId}`);
        expect(ex).toBe('EX');
        expect(expiry).toBe(3600);
        const parsedValue = JSON.parse(value);
        expect(parsedValue).toEqual(
          expect.objectContaining({
            step: 'awaiting_delete_confirmation',
            eventId: 'event1',
            calendarId: 'primary',
            chatId: 'testUser',
          })
        );
    });
  });
});