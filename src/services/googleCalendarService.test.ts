import { CalendarEvent } from './geminiService';

// We need to get a handle on the mock functions created inside the factory.
// So we define them here and they will be reassigned inside the mock factory.
let mockEventsList: jest.Mock;
let mockEventsInsert: jest.Mock;

// Mock the entire 'googleapis' module using a factory function
jest.mock('googleapis', () => {
  // Create the mock functions inside the factory to avoid hoisting issues
  mockEventsList = jest.fn();
  mockEventsInsert = jest.fn();

  return {
    google: {
      auth: {
        OAuth2: jest.fn().mockImplementation(() => ({
          setCredentials: jest.fn(),
        })),
      },
      calendar: jest.fn().mockReturnValue({
        events: {
          list: mockEventsList,
          insert: mockEventsInsert,
        },
      }),
    },
  };
});

// Import the service-under-test AFTER the mock has been defined.
import { createCalendarEvent, DuplicateEventError } from './googleCalendarService';

describe('googleCalendarService', () => {
  beforeEach(() => {
    // Clear mock history before each test to ensure isolation
    mockEventsList.mockClear();
    mockEventsInsert.mockClear();
  });

  describe('createCalendarEvent', () => {
    const sampleEvent: CalendarEvent = {
      title: 'Test Meeting',
      start: '2025-09-01T10:00:00+08:00',
      end: '2025-09-01T11:00:00+08:00',
      allDay: false,
      recurrence: null,
      reminder: 30,
      calendarId: 'primary',
    };

    test('(C-1) should create a new event if no duplicate is found', async () => {
      mockEventsList.mockResolvedValue({ data: { items: [] } });
      const mockCreatedEvent = { summary: 'Test Meeting', htmlLink: 'http://google.com/calendar/event' };
      mockEventsInsert.mockResolvedValue({ data: mockCreatedEvent });

      const result = await createCalendarEvent(sampleEvent);

      expect(mockEventsList).toHaveBeenCalledWith({
        calendarId: 'primary',
        q: 'Test Meeting',
        timeMin: '2025-09-01T10:00:00+08:00',
        singleEvents: true,
      });
      expect(mockEventsInsert).toHaveBeenCalled();
      expect(result).toEqual(mockCreatedEvent);
    });

    test('(C-1) should throw a DuplicateEventError if an identical event is found', async () => {
      const identicalEvent = {
        summary: 'Test Meeting',
        start: { dateTime: '2025-09-01T10:00:00+08:00' },
        end: { dateTime: '2025-09-01T11:00:00+08:00' },
        htmlLink: 'http://google.com/calendar/event/duplicate',
      };
      mockEventsList.mockResolvedValue({ data: { items: [identicalEvent] } });

      await expect(createCalendarEvent(sampleEvent)).rejects.toThrow(DuplicateEventError);
      await expect(createCalendarEvent(sampleEvent)).rejects.toHaveProperty(
        'htmlLink',
        'http://google.com/calendar/event/duplicate'
      );
      expect(mockEventsInsert).not.toHaveBeenCalled();
    });

    test('should create a new event if a similar, but not identical, event is found', async () => {
      const similarEvent = {
        summary: 'Test Meeting',
        start: { dateTime: '2025-09-01T14:00:00+08:00' },
        end: { dateTime: '2025-09-01T15:00:00+08:00' },
      };
      mockEventsList.mockResolvedValue({ data: { items: [similarEvent] } });
      const mockCreatedEvent = { summary: 'Test Meeting' };
      mockEventsInsert.mockResolvedValue({ data: mockCreatedEvent });

      await createCalendarEvent(sampleEvent);

      expect(mockEventsInsert).toHaveBeenCalled();
    });
  });
});