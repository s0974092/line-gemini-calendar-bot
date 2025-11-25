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

    it('should create an event with location and description', async () => {
      const eventWithDetails = {
        ...event,
        location: '123 Main St',
        description: 'Project kickoff meeting',
      };
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: [] } });
      mockGoogleApi.events.insert.mockResolvedValue({ data: { htmlLink: 'http://example.com/event' } });

      await createCalendarEvent(eventWithDetails, 'primary');

      expect(mockGoogleApi.events.insert).toHaveBeenCalledWith(expect.objectContaining({
        requestBody: expect.objectContaining({
          summary: eventWithDetails.title,
          location: eventWithDetails.location,
          description: eventWithDetails.description,
        }),
      }));
    });

    it('should throw DuplicateEventError with correct link for an identical timed event', async () => {
      const existingEvent = {
        summary: 'Test Event',
        start: { dateTime: '2025-01-01T10:00:00+08:00' },
        end: { dateTime: '2025-01-01T11:00:00+08:00' },
        htmlLink: 'http://example.com/duplicate',
      };
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: [existingEvent] } });

      expect.assertions(3);
      try {
        await createCalendarEvent(event, 'primary');
      } catch (e: any) {
        expect(e).toBeInstanceOf(DuplicateEventError);
        expect(e.htmlLink).toBe('http://example.com/duplicate');
      }
      expect(mockGoogleApi.events.insert).not.toHaveBeenCalled();
    });

    it('should throw DuplicateEventError with correct link for an identical all-day event', async () => {
        const allDayEvent = { ...event, allDay: true, start: '2025-01-02T00:00:00+08:00', end: '2025-01-03T00:00:00+08:00' };
        const existingAllDayEvent = {
            summary: 'Test Event',
            start: { date: '2025-01-02' },
            htmlLink: 'http://example.com/duplicate_allday',
        };
        mockGoogleApi.events.list.mockResolvedValue({ data: { items: [existingAllDayEvent] } });

        expect.assertions(3);
        try {
            await createCalendarEvent(allDayEvent, 'primary');
        } catch (e: any) {
            expect(e).toBeInstanceOf(DuplicateEventError);
            expect(e.htmlLink).toBe('http://example.com/duplicate_allday');
        }
        expect(mockGoogleApi.events.insert).not.toHaveBeenCalled();
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
                    useDefault: true,
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

    it('should handle date-only strings when checking for duplicates and creating events', async () => {
      const dateOnlyEvent = {
        title: 'Date Only Event',
        start: '2025-02-10',
        end: '2025-02-11',
        allDay: true,
      };
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: [] } });
      mockGoogleApi.events.insert.mockResolvedValue({ data: { htmlLink: 'http://example.com/date-only-event' } });

      await createCalendarEvent(dateOnlyEvent, 'primary');

      // 驗證 isDateOnly 分支
      expect(mockGoogleApi.events.list).toHaveBeenCalledWith(expect.objectContaining({
        timeMin: new Date('2025-02-10').toISOString(),
        timeMax: new Date('2025-02-11').toISOString(),
      }));

      // 驗證事件是作為全天事件創建的
      expect(mockGoogleApi.events.insert).toHaveBeenCalledWith(expect.objectContaining({
        requestBody: expect.objectContaining({
          start: { date: '2025-02-10', timeZone: 'Asia/Taipei' },
          end: { date: '2025-02-11', timeZone: 'Asia/Taipei' },
        }),
      }));
    });

    it('should not throw duplicate error for an all-day event clashing with a timed event', async () => {
      const newAllDayEvent = {
        title: 'All Day Clash',
        start: '2025-01-06',
        end: '2025-01-07',
        allDay: true,
      };
      const existingTimedEvent = {
        summary: 'All Day Clash',
        start: { dateTime: '2025-01-06T10:00:00+08:00' },
        end: { dateTime: '2025-01-06T11:00:00+08:00' },
        htmlLink: 'http://example.com/timed-event',
      };
      
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: [existingTimedEvent] } });
      mockGoogleApi.events.insert.mockResolvedValue({ data: { htmlLink: 'http://example.com/new-all-day-event' } });

      await createCalendarEvent(newAllDayEvent, 'primary');

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

    it('Test Case 3.1: should return a default primary calendar choice if none is found', async () => {
      const mockCalendars = [
        { id: 'cal1', summary: 'Calendar 1', primary: false },
        { id: 'cal2', summary: 'Calendar 2', primary: false },
      ];
      mockGoogleApi.calendarList.list.mockResolvedValue({ data: { items: mockCalendars } });

      const choices = await getCalendarChoicesForUser();
      
      // Even if no primary is in the list, the first choice should be the default primary.
      expect(choices[0]).toEqual({ id: 'primary', summary: '我的主要日曆' });
    });

    it('Test Case 3.2: should limit choices to 3 even if more are available', async () => {
        process.env.TARGET_CALENDAR_NAME = 'Cal1,Cal2,Cal3';
        const mockCalendars = [
            { id: 'primary_id', summary: '我的主要日曆', primary: true },
            { id: 'cal1_id', summary: 'Cal1' },
            { id: 'cal2_id', summary: 'Cal2' },
            { id: 'cal3_id', summary: 'Cal3' },
        ];
        mockGoogleApi.calendarList.list.mockResolvedValue({ data: { items: mockCalendars } });

        const choices = await getCalendarChoicesForUser();

        expect(choices).toHaveLength(3);
        // It should contain primary, Cal1, and Cal2, but NOT Cal3.
        expect(choices.map((c: { summary: string }) => c.summary)).toEqual(['我的主要日曆', 'Cal1', 'Cal2']);
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
      const result = await findEventsInTimeRange('primary', '2025-01-01T00:00:00Z', '2025-01-01T23:59:59Z', 'Test');
      expect(result).toEqual(mockEvents);
    });

    it('should throw an error if the API call fails', async () => {
        mockGoogleApi.events.list.mockRejectedValue(new Error('API Error'));
        await expect(findEventsInTimeRange('primary', '2025-01-01T00:00:00Z', '2025-01-01T23:59:59Z', 'Test')).rejects.toThrow('Failed to find events in the specified time range.');
    });

    it('should handle date-only strings for startTime and endTime', async () => {
      const mockEvents = [{ id: 'event1', summary: 'Event 1' }];
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: mockEvents } });
      
      await findEventsInTimeRange('primary', '2025-03-10', '2025-03-12', 'Date-only query');

      expect(mockGoogleApi.events.list).toHaveBeenCalledWith(expect.objectContaining({
        timeMin: new Date('2025-03-10').toISOString(),
        timeMax: new Date('2025-03-12').toISOString(),
      }));
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

    it('Test Case 4.1: should default timeMin to now if it is null', async () => {
      const now = new Date('2025-11-04T10:00:00Z');
      jest.spyOn(global, 'Date').mockImplementation(() => now as any);

      mockGoogleApi.events.list.mockResolvedValue({ data: { items: [] } });
      await searchEvents('primary', null, null, 'Test');

      expect(mockGoogleApi.events.list).toHaveBeenCalledWith(expect.objectContaining({
        timeMin: '2025-11-04T10:00:00.000Z',
      }));
      (global.Date as any).mockRestore();
    });

    it('Test Case 4.2: should pass timeMax to the API if it has a value', async () => {
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: [] } });
      await searchEvents('primary', '2025-01-01T00:00:00Z', '2025-01-31T23:59:59Z', 'Test');

      expect(mockGoogleApi.events.list).toHaveBeenCalledWith(expect.objectContaining({
        timeMax: '2025-01-31T23:59:59Z',
      }));
    });

    it('Test Case 4.3: should handle null timeMin and valued timeMax correctly', async () => {
      const now = new Date('2025-11-04T10:00:00Z');
      jest.spyOn(global, 'Date').mockImplementation(() => now as any);

      mockGoogleApi.events.list.mockResolvedValue({ data: { items: [] } });
      await searchEvents('primary', null, '2025-12-31T23:59:59Z', 'Test');

      expect(mockGoogleApi.events.list).toHaveBeenCalledWith(expect.objectContaining({
        timeMin: '2025-11-04T10:00:00.000Z',
        timeMax: '2025-12-31T23:59:59Z',
      }));
      (global.Date as any).mockRestore();
    });

    it('should not include timeMax in API call if it is null', async () => {
      mockGoogleApi.events.list.mockResolvedValue({ data: { items: [] } });
      await searchEvents('primary', new Date().toISOString(), null, 'Test');

      const calledWith = mockGoogleApi.events.list.mock.calls[0][0];
      expect(calledWith).not.toHaveProperty('timeMax');
    });
  });

  describe('updateEvent', () => {
    it('should update an event and return the updated data', async () => {
      const updatedEventData = { id: 'eventId', summary: 'Updated Title' };
      mockGoogleApi.events.patch.mockResolvedValue({ data: updatedEventData });
      const result = await updateEvent('eventId', 'primary', { summary: 'Updated Title' });
      expect(result).toEqual(updatedEventData);
    });

    it('should update an event with location and description', async () => {
      const eventPatch = { location: 'New Location', description: 'New Description' };
      const updatedEventData = { id: 'eventId', ...eventPatch };
      mockGoogleApi.events.patch.mockResolvedValue({ data: updatedEventData });
      await updateEvent('eventId', 'primary', eventPatch);
      expect(mockGoogleApi.events.patch).toHaveBeenCalledWith({
        calendarId: 'primary',
        eventId: 'eventId',
        requestBody: eventPatch,
      });
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
