// 這是解決 Jest mock 提升問題的變通方法。
// 我們使用 jest.doMock 來避免 ReferenceError。
const mockGoogleApi = {
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
};

jest.doMock('googleapis', () => ({
  google: {
    auth: {
      OAuth2: jest.fn(() => ({
        setCredentials: jest.fn(),
      })),
    },
    calendar: jest.fn(() => ({
      events: mockGoogleApi.events,
      calendarList: mockGoogleApi.calendarList,
    })),
  },
}));

describe('googleCalendarService', () => {
  let createCalendarEvent: any;
  let DuplicateEventError: any;
  let listAllCalendars: any;
  let getCalendarChoicesForUser: any;
  let searchEvents: any;
  let updateEvent: any;
  let deleteEvent: any;
  let findEventsInTimeRange: any;
  let getEventById: any;

  beforeEach(() => {
    jest.resetModules();
    Object.values(mockGoogleApi.events).forEach(mockFn => mockFn.mockClear());
    mockGoogleApi.calendarList.list.mockClear();
    process.env.TARGET_CALENDAR_NAME = ''; // 重設環境變數

    // 在 mock 設定完成後，在此處引入模組
    const googleCalendarService = require('./googleCalendarService');
    createCalendarEvent = googleCalendarService.createCalendarEvent;
    DuplicateEventError = googleCalendarService.DuplicateEventError;
    listAllCalendars = googleCalendarService.listAllCalendars;
    getCalendarChoicesForUser = googleCalendarService.getCalendarChoicesForUser;
    searchEvents = googleCalendarService.searchEvents;
    updateEvent = googleCalendarService.updateEvent;
    deleteEvent = googleCalendarService.deleteEvent;
    findEventsInTimeRange = googleCalendarService.findEventsInTimeRange;
    getEventById = googleCalendarService.getEventById;
  });

  describe('createCalendarEvent', () => {
    const event = {
        title: 'Test Event',
        start: '2025-01-01T10:00:00+08:00',
        end: '2025-01-01T11:00:00+08:00',
        allDay: false,
        recurrence: null,
        reminder: 30,
        calendarId: 'primary',
      };

    it('should create an event if no duplicates are found', async () => {
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: [] } });
      mockGoogleApi.events.insert.mockResolvedValue({ data: { htmlLink: 'http://example.com/event' } });

      const result = await createCalendarEvent(event, 'primary');
      expect(result).toEqual({ htmlLink: 'http://example.com/event' });
      expect(mockGoogleApi.events.insert).toHaveBeenCalled();
    });

    it('should throw DuplicateEventError if an identical event exists', async () => {
      const existingEvent = {
        summary: 'Test Event',
        start: { dateTime: '2025-01-01T10:00:00+08:00' },
        end: { dateTime: '2025-01-01T11:00:00+08:00' },
        htmlLink: 'http://example.com/duplicate',
      };
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: [existingEvent] } });

      await expect(createCalendarEvent(event, 'primary')).rejects.toThrow(DuplicateEventError);
      expect(mockGoogleApi.events.insert).not.toHaveBeenCalled();
    });

    it('should throw DuplicateEventError for an identical all-day event', async () => {
        const allDayEvent = { ...event, allDay: true, start: '2025-01-02T00:00:00+08:00', end: '2025-01-03T00:00:00+08:00' };
        const existingAllDayEvent = {
            summary: 'Test Event',
            start: { date: '2025-01-02' },
            htmlLink: 'http://example.com/duplicate_allday',
        };
        mockGoogleApi.events.list.mockResolvedValue({ data: { items: [existingAllDayEvent] } });

        await expect(createCalendarEvent(allDayEvent, 'primary')).rejects.toThrow(DuplicateEventError);
    });

    it('should throw an error if the insert API call fails', async () => {
        mockGoogleApi.events.list.mockResolvedValue({ data: { items: [] } });
        mockGoogleApi.events.insert.mockRejectedValue(new Error('API Error'));
        await expect(createCalendarEvent(event, 'primary')).rejects.toThrow('Failed to create Google Calendar event.');
    });

    it('should create event when existingEvents.data.items is null', async () => {
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: null } });
      mockGoogleApi.events.insert.mockResolvedValue({ data: { htmlLink: 'http://example.com/event' } });
      await createCalendarEvent(event, 'primary');
      expect(mockGoogleApi.events.insert).toHaveBeenCalled();
    });

    it('should not throw duplicate error for event with same title but different time', async () => {
      const existingEvent = {
        summary: 'Test Event',
        start: { dateTime: '2025-01-02T10:00:00+08:00' }, // Different time
        end: { dateTime: '2025-01-02T11:00:00+08:00' },
        htmlLink: 'http://example.com/other',
      };
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: [existingEvent] } });
      mockGoogleApi.events.insert.mockResolvedValue({ data: { htmlLink: 'http://example.com/event' } });
      await createCalendarEvent(event, 'primary');
      expect(mockGoogleApi.events.insert).toHaveBeenCalled();
    });

    it('should create an event with recurrence rule', async () => {
        const recurringEvent = { ...event, recurrence: 'RRULE:FREQ=DAILY;COUNT=5' };
        mockGoogleApi.events.list.mockResolvedValue({ data: { items: [] } });
        mockGoogleApi.events.insert.mockResolvedValue({ data: { htmlLink: 'http://example.com/event' } });
        await createCalendarEvent(recurringEvent, 'primary');
        expect(mockGoogleApi.events.insert).toHaveBeenCalledWith(expect.objectContaining({
            requestBody: expect.objectContaining({
                recurrence: ['RRULE:FREQ=DAILY;COUNT=5'],
            }),
        }));
    });

    it('should create an event with default reminder if not provided', async () => {
        const eventWithoutReminder = { ...event };
        delete (eventWithoutReminder as Partial<typeof event>).reminder;
        mockGoogleApi.events.list.mockResolvedValue({ data: { items: [] } });
        mockGoogleApi.events.insert.mockResolvedValue({ data: { htmlLink: 'http://example.com/event' } });
        await createCalendarEvent(eventWithoutReminder, 'primary');
        expect(mockGoogleApi.events.insert).toHaveBeenCalledWith(expect.objectContaining({
            requestBody: expect.objectContaining({
                reminders: {
                    useDefault: false,
                    overrides: [{ method: 'popup', minutes: 30 }], // default
                },
            }),
        }));
    });

    it('should not throw duplicate error for a timed event clashing with an all-day event of the same name', async () => {
      const newTimedEvent = {
        title: 'Clash Event',
        start: '2025-01-05T10:00:00+08:00',
        end: '2025-01-05T11:00:00+08:00',
        allDay: false,
        recurrence: null,
        reminder: 30,
        calendarId: 'primary',
      };
      const existingAllDayEvent = {
        summary: 'Clash Event',
        start: { date: '2025-01-05' }, // Same day, but all-day
        htmlLink: 'http://example.com/all-day-event',
      };
      
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: [existingAllDayEvent] } });
      mockGoogleApi.events.insert.mockResolvedValue({ data: { htmlLink: 'http://example.com/new-timed-event' } });

      await createCalendarEvent(newTimedEvent, 'primary');

      expect(mockGoogleApi.events.insert).toHaveBeenCalled();
    });
  });

  describe('listAllCalendars', () => {
    it('should return a list of calendars', async () => {
      const mockCalendars = [{ id: 'primary', summary: 'Primary Calendar' }];
      mockGoogleApi.calendarList.list.mockResolvedValue({ data: { items: mockCalendars } });
      const result = await listAllCalendars();
      expect(result).toEqual(mockCalendars);
    });

    it('should return an empty array if no items are returned', async () => {
        mockGoogleApi.calendarList.list.mockResolvedValue({ data: { items: null } });
        const result = await listAllCalendars();
        expect(result).toEqual([]);
    });

    it('should throw an error if the API call fails', async () => {
        mockGoogleApi.calendarList.list.mockRejectedValue(new Error('API Error'));
        await expect(listAllCalendars()).rejects.toThrow('Failed to list calendars.');
    });
  });

  describe('getCalendarChoicesForUser', () => {
    it('should get calendar choices based on TARGET_CALENDAR_NAME', async () => {
      const mockCalendars = [
        { id: 'primary', summary: '我的主要日曆', primary: true },
        { id: 'family_id', summary: '家庭' },
        { id: 'work_id', summary: '工作' },
      ];
      mockGoogleApi.calendarList.list.mockResolvedValue({ data: { items: mockCalendars } });
      process.env.TARGET_CALENDAR_NAME = '家庭,工作';

      const choices = await getCalendarChoicesForUser();
      expect(choices).toHaveLength(3);
      expect(choices).toEqual(expect.arrayContaining([
        { id: 'primary', summary: '我的主要日曆' },
        { id: 'family_id', summary: '家庭' },
        { id: 'work_id', summary: '工作' },
      ]));
    });

    it('should return only primary if fetching calendars fails', async () => {
        mockGoogleApi.calendarList.list.mockRejectedValue(new Error('API Error'));
        const choices = await getCalendarChoicesForUser();
        expect(choices).toEqual([{ id: 'primary', summary: '我的主要日曆' }]);
    });

    it('should default to primary if no primary calendar is found in the list', async () => {
        const mockCalendars = [{ id: 'some_id', summary: 'Some Calendar' }];
        mockGoogleApi.calendarList.list.mockResolvedValue({ data: { items: mockCalendars } });
        const choices = await getCalendarChoicesForUser();
        expect(choices).toEqual([{ id: 'primary', summary: '我的主要日曆' }]);
    });

    it('should respect the CALENDAR_CHOICE_LIMIT', async () => {
        const mockCalendars = [
            { id: 'primary', summary: '我的主要日曆', primary: true },
            { id: 'c1', summary: 'C1' },
            { id: 'c2', summary: 'C2' },
            { id: 'c3', summary: 'C3' },
        ];
        mockGoogleApi.calendarList.list.mockResolvedValue({ data: { items: mockCalendars } });
        process.env.TARGET_CALENDAR_NAME = 'C1,C2,C3';
        const choices = await getCalendarChoicesForUser();
        expect(choices).toHaveLength(3);
        expect(choices.some((c: { id: string; }) => c.id === 'c3')).toBeFalsy(); // c3 should be excluded
    });

    it('should handle empty TARGET_CALENDAR_NAME', async () => {
      const mockCalendars = [
        { id: 'primary', summary: '我的主要日曆', primary: true },
        { id: 'family_id', summary: '家庭' },
      ];
      mockGoogleApi.calendarList.list.mockResolvedValue({ data: { items: mockCalendars } });
      process.env.TARGET_CALENDAR_NAME = ''; // Empty
      const choices = await getCalendarChoicesForUser();
      expect(choices).toHaveLength(1);
      expect(choices[0].id).toBe('primary');
    });

    it('should handle target calendar name not found', async () => {
        const mockCalendars = [
            { id: 'primary', summary: '我的主要日曆', primary: true },
        ];
        mockGoogleApi.calendarList.list.mockResolvedValue({ data: { items: mockCalendars } });
        process.env.TARGET_CALENDAR_NAME = 'NonExistentCalendar';
        const choices = await getCalendarChoicesForUser();
        expect(choices).toHaveLength(1);
        expect(choices[0].id).toBe('primary');
    });

    it('should return default choice when listAllCalendars fails', async () => {
      mockGoogleApi.calendarList.list.mockRejectedValue(new Error('API Error'));
      const choices = await getCalendarChoicesForUser();
      expect(choices).toEqual([{ id: 'primary', summary: '我的主要日曆' }]);
    });
  });

  describe('findEventsInTimeRange', () => {
    it('should return events within the specified time range', async () => {
      const mockEvents = [{ id: 'event1', summary: 'Event 1' }];
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: mockEvents } });
      const result = await findEventsInTimeRange('2025-01-01T00:00:00Z', '2025-01-01T23:59:59Z', 'primary');
      expect(result).toEqual(mockEvents);
    });

    it('should throw an error if the API call fails', async () => {
        mockGoogleApi.events.list.mockRejectedValue(new Error('API Error'));
        await expect(findEventsInTimeRange('2025-01-01T00:00:00Z', '2025-01-01T23:59:59Z', 'primary')).rejects.toThrow('Failed to find events in the specified time range.');
    });
  });

  describe('searchEvents', () => {
    it('should search events with the given parameters', async () => {
      const mockEvents = [{ id: 'event1', summary: 'Found Event' }];
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: mockEvents, nextPageToken: null } });
      const result = await searchEvents('primary', '2025-01-01T00:00:00Z', '2025-01-01T23:59:59Z', 'Test');
      expect(result).toEqual({ events: mockEvents, nextPageToken: null });
    });

    it('should throw an error if the API call fails', async () => {
        mockGoogleApi.events.list.mockRejectedValue(new Error('API Error'));
        await expect(searchEvents('primary', '2025-01-01T00:00:00Z', '2025-01-01T23:59:59Z', 'Test')).rejects.toThrow('Failed to search for events.');
    });

    it('should search without timeMin, defaulting to now', async () => {
      const mockEvents = [{ id: 'event1', summary: 'Found Event' }];
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: mockEvents, nextPageToken: null } });
      const result = await searchEvents('primary', null, '2025-01-01T23:59:59Z', 'Test');
      expect(mockGoogleApi.events.list).toHaveBeenCalledWith(expect.objectContaining({
        timeMin: expect.any(String), // Check that it's a string, which means it was set
        timeMax: '2025-01-01T23:59:59Z',
      }));
      expect(result.events).toEqual(mockEvents);
    });

    it('should search without timeMax', async () => {
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: [], nextPageToken: null } });
      await searchEvents('primary', '2025-01-01T00:00:00Z', null, 'Test');
      const calledWith = mockGoogleApi.events.list.mock.calls[0][0];
      expect(calledWith).not.toHaveProperty('timeMax');
    });

    it('should search without a keyword', async () => {
        mockGoogleApi.events.list.mockResolvedValue({ data: { items: [], nextPageToken: null } });
        await searchEvents('primary', '2025-01-01T00:00:00Z', '2025-01-01T23:59:59Z', undefined);
        const calledWith = mockGoogleApi.events.list.mock.calls[0][0];
        expect(calledWith.q).toBeUndefined();
    });
  });

  describe('updateEvent', () => {
    it('should update an event and return the updated data', async () => {
      const updatedEventData = { id: 'eventId', summary: 'Updated Title' };
      mockGoogleApi.events.patch.mockResolvedValue({ data: updatedEventData });
      const result = await updateEvent('eventId', 'primary', { summary: 'Updated Title' });
      expect(result).toEqual(updatedEventData);
    });

    it('should throw an error if the API call fails', async () => {
        mockGoogleApi.events.patch.mockRejectedValue(new Error('API Error'));
        await expect(updateEvent('eventId', 'primary', { summary: 'Updated Title' })).rejects.toThrow('Failed to update Google Calendar event.');
    });
  });

  describe('deleteEvent', () => {
    it('should delete an event', async () => {
      mockGoogleApi.events.delete.mockResolvedValue({});
      await deleteEvent('eventId', 'primary');
      expect(mockGoogleApi.events.delete).toHaveBeenCalledWith({ calendarId: 'primary', eventId: 'eventId' });
    });

    it('should throw an error if the API call fails', async () => {
        mockGoogleApi.events.delete.mockRejectedValue(new Error('API Error'));
        await expect(deleteEvent('eventId', 'primary')).rejects.toThrow('Failed to delete Google Calendar event.');
    });
  });

  describe('getEventById', () => {
    it('should return an event by ID', async () => {
      const mockEvent = { id: 'eventId', summary: 'Event' };
      mockGoogleApi.events.get.mockResolvedValue({ data: mockEvent });
      const result = await getEventById('eventId', 'primary');
      expect(result).toEqual(mockEvent);
      expect(mockGoogleApi.events.get).toHaveBeenCalledWith({ calendarId: 'primary', eventId: 'eventId' });
    });

    it('should throw an error if the API call fails', async () => {
      mockGoogleApi.events.get.mockRejectedValue(new Error('API Error'));
      await expect(getEventById('eventId', 'primary')).rejects.toThrow('Failed to get event by ID.');
    });
  });
});