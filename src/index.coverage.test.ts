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
import { DuplicateEventError } from './services/googleCalendarService';

describe('index.ts functional tests', () => {
  const userId = 'testUser';
  const replyToken = 'testReplyToken';
  let index: any; // To hold the required module

  beforeEach(() => {
    jest.resetModules();
    mockRedisGet.mockResolvedValue(undefined);
    mockClassifyIntent.mockResolvedValue({ type: 'unknown', originalText: '' });
    process.env.USER_WHITELIST = 'testUser';
    process.env.LINE_CHANNEL_SECRET = 'test-secret';
    process.env.LINE_CHANNEL_ACCESS_TOKEN = 'test-token';
    index = require('./index');
  });

  afterEach(() => {
    jest.clearAllMocks();
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
      expect(bubble1.footer.contents.length).toBe(2);

      // Check bubble 2 (truncation)
      const bubble2 = carousel.contents[1];
      expect(bubble2.header.contents[0].text).toBe('日曆：Work Calendar');
      expect(bubble2.body.contents[0].text).toBe('Event 2 With A Very Long Title That Should Be Truncated');
      expect(bubble2.footer.contents.length).toBe(2);

      // Check bubble 3 (no link)
      const bubble3 = carousel.contents[2];
      expect(bubble3.footer.contents.length).toBe(1);
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
        await index.handleNewCommand(replyToken, message, userId);

        expect(mockRedisSet).toHaveBeenCalledWith(userId, expect.stringContaining('"step":"awaiting_delete_confirmation"'), 'EX', 3600);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, expect.objectContaining({
            template: expect.objectContaining({
                type: 'confirm',
                text: '您確定要刪除活動「The Meeting」嗎？此操作無法復原。'
            })
        }));
    });
  });

  describe('handlePostbackEvent', () => {
    it('should create event and reply with confirmation on create_after_choice success', async () => {
        const eventToCreate = { title: 'Final Event', start: '2025-01-01T10:00:00Z', end: '2025-01-01T11:00:00Z' };
        const state = { step: 'awaiting_calendar_choice', event: eventToCreate, timestamp: Date.now() };
        mockRedisGet.mockResolvedValue(JSON.stringify(state));
        mockFindEventsInTimeRange.mockResolvedValue([]);
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'cal99', summary: 'Chosen Calendar' }]);
        mockCreateCalendarEvent.mockResolvedValue({ htmlLink: 'final_link' });

        const postbackData = new URLSearchParams({ action: 'create_after_choice', calendarId: 'cal99' }).toString();
        const event = { replyToken, source: { userId }, postback: { data: postbackData } } as PostbackEvent;
        await index.handlePostbackEvent(event);

        expect(mockCreateCalendarEvent).toHaveBeenCalledWith(eventToCreate, 'cal99');
        expect(mockRedisDel).toHaveBeenCalledWith(userId);
        expect(mockReplyMessage).toHaveBeenCalledWith(replyToken, expect.objectContaining({
            type: 'flex',
            altText: '活動已新增：Final Event',
            contents: expect.objectContaining({
                type: 'bubble',
                header: expect.objectContaining({
                    contents: expect.arrayContaining([
                        expect.objectContaining({ text: '✅ 已新增至「Chosen Calendar」' })
                    ])
                }),
                body: expect.objectContaining({
                    contents: expect.arrayContaining([
                        expect.objectContaining({ text: 'Final Event' })
                    ])
                }),
                footer: expect.objectContaining({
                    contents: expect.arrayContaining([
                        expect.objectContaining({
                            action: expect.objectContaining({ uri: 'final_link' })
                        })
                    ])
                })
            })
        }));
    });
  });

  describe('sendCreationConfirmation', () => {
    const baseEvent = { title: 'My Test Event', allDay: false, start: '2025-01-20T10:00:00+08:00', end: '2025-01-20T11:00:00+08:00' } as CalendarEvent;

    it('should handle a single matching event from a seeded event', async () => {
        const createdEvent = {
            summary: baseEvent.title,
            start: { dateTime: baseEvent.start },
            htmlLink: 'http://example.com/seeded',
            organizer: { email: 'primary' }
        };
        mockGetCalendarChoicesForUser.mockResolvedValue([{ id: 'primary', summary: 'My Calendar' }]);
        mockCalendarEventsList.mockResolvedValue({ data: { items: [] } });

        await index.sendCreationConfirmation(userId, baseEvent, createdEvent);

        expect(mockPushMessage).toHaveBeenCalledWith(userId, expect.objectContaining({
            type: 'flex',
            altText: '活動「My Test Event」已新增',
            contents: expect.objectContaining({
                type: 'bubble',
                header: expect.objectContaining({
                    contents: expect.arrayContaining([
                        expect.objectContaining({ text: '✅ 已新增至「My Calendar」' })
                    ])
                }),
                body: expect.objectContaining({
                    contents: expect.arrayContaining([
                        expect.objectContaining({ text: 'My Test Event' })
                    ])
                })
            })
        }));
    });
  });
});

