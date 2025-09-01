import { createCalendarEvent, DuplicateEventError, listAllCalendars, getCalendarChoicesForUser } from './googleCalendarService';

const mockEventsList = jest.fn();
const mockEventsInsert = jest.fn();
const mockCalendarListList = jest.fn();

jest.mock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn(() => ({
        setCredentials: jest.fn(),
      })),
    },
    calendar: jest.fn(() => ({
      events: {
        list: mockEventsList,
        insert: mockEventsInsert,
      },
      calendarList: {
        list: mockCalendarListList,
      },
    })),
  },
}));

describe('createCalendarEvent', () => {
  beforeEach(() => {
    mockEventsList.mockClear();
    mockEventsInsert.mockClear();
  });

  it('should create an event if no duplicates are found', async () => {
    mockEventsList.mockResolvedValue({ data: { items: [] } });
    mockEventsInsert.mockResolvedValue({ data: { htmlLink: 'http://example.com/event' } });

    const event = {
      title: 'Test Event',
      start: '2025-01-01T10:00:00+08:00',
      end: '2025-01-01T11:00:00+08:00',
      allDay: false,
      recurrence: null,
      reminder: 30,
      calendarId: 'primary',
    };

    const result = await createCalendarEvent(event, 'primary');
    expect(result).toEqual({ htmlLink: 'http://example.com/event' });
  });

  it('should throw DuplicateEventError if an identical event exists', async () => {
    const existingEvent = {
      summary: 'Test Event',
      start: { dateTime: '2025-01-01T10:00:00+08:00' },
      end: { dateTime: '2025-01-01T11:00:00+08:00' },
      htmlLink: 'http://example.com/duplicate',
    };
    mockEventsList.mockResolvedValue({ data: { items: [existingEvent] } });

    const event = {
      title: 'Test Event',
      start: '2025-01-01T10:00:00+08:00',
      end: '2025-01-01T11:00:00+08:00',
      allDay: false,
      recurrence: null,
      reminder: 30,
      calendarId: 'primary',
    };

    await expect(createCalendarEvent(event, 'primary')).rejects.toThrow(DuplicateEventError);
  });
});

describe('listAllCalendars', () => {
  beforeEach(() => {
    mockCalendarListList.mockClear();
  });

  it('should return a list of calendars', async () => {
    const mockCalendars = [{ id: 'primary', summary: 'Primary Calendar' }];
    mockCalendarListList.mockResolvedValue({ data: { items: mockCalendars } });
    const result = await listAllCalendars();
    expect(result).toEqual(mockCalendars);
  });
});

describe('getCalendarChoicesForUser', () => {
  beforeEach(() => {
    mockCalendarListList.mockClear();
  });

  it('should get calendar choices', async () => {
    const mockCalendars = [
      { id: 'primary', summary: '我的主要日曆' },
      { id: 'family_id', summary: '家庭' },
    ];
    mockCalendarListList.mockResolvedValue({ data: { items: mockCalendars } });
    process.env.TARGET_CALENDAR_NAME = '家庭';

    const choices = await getCalendarChoicesForUser();
    expect(choices).toEqual([
      { id: 'primary', summary: '我的主要日曆' },
      { id: 'family_id', summary: '家庭' },
    ]);
  });
});