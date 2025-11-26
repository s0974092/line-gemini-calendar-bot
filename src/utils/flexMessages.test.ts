import { createEventFlexBubble } from './flexMessages';

// Mock the time module
jest.mock('./time', () => ({
  formatEventTime: jest.fn(),
  getConciseRecurrenceDescription: jest.fn(),
}));

// Mock the googleCalendarService
jest.mock('../services/googleCalendarService', () => ({
  getCalendarChoicesForUser: jest.fn().mockResolvedValue([]),
}));

import { formatEventTime } from './time';

const mockFormatEventTime = formatEventTime as jest.MockedFunction<typeof formatEventTime>;

describe('flexMessages', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  describe('createEventFlexBubble', () => {
    it('should create a basic event bubble without optional fields', async () => {
      mockFormatEventTime.mockResolvedValue({ primary: '2025年1月1日 10:00 - 11:00' });
      
      const event = {
        summary: 'Test Event',
        start: { dateTime: '2025-01-01T10:00:00Z' },
        end: { dateTime: '2025-01-01T11:00:00Z' },
      };

      const bubble = await createEventFlexBubble(event, '✅ Test Header');

      expect(bubble.type).toBe('bubble');
      expect(bubble.header?.contents[0]).toMatchObject({
        text: '✅ Test Header',
        weight: 'bold',
        color: '#1DB446',
      });
      expect(bubble.body?.contents[0]).toMatchObject({
        text: 'Test Event',
        weight: 'bold',
        size: 'xl',
      });
      expect(bubble.body?.contents[1]).toMatchObject({
        text: '2025年1月1日 10:00 - 11:00',
      });
    });

    it('should include location when provided', async () => {
      mockFormatEventTime.mockResolvedValue({ primary: '2025年1月1日 10:00' });
      
      const event = {
        summary: 'Meeting',
        start: { dateTime: '2025-01-01T10:00:00Z' },
        location: 'Conference Room A',
      };

      const bubble = await createEventFlexBubble(event, 'Header');

      // Find the location content in body
      const bodyContents = bubble.body?.contents || [];
      const hasLocation = bodyContents.some((c: any) => 
        c.type === 'box' && JSON.stringify(c).includes('Conference Room A')
      );
      expect(hasLocation).toBe(true);
    });

    it('should include description when provided', async () => {
      mockFormatEventTime.mockResolvedValue({ primary: '2025年1月1日 10:00' });
      
      const event = {
        summary: 'Meeting',
        start: { dateTime: '2025-01-01T10:00:00Z' },
        description: 'Discuss Q4 goals',
      };

      const bubble = await createEventFlexBubble(event, 'Header');

      const bodyContents = bubble.body?.contents || [];
      const hasDescription = bodyContents.some((c: any) => 
        c.type === 'box' && JSON.stringify(c).includes('Discuss Q4 goals')
      );
      expect(hasDescription).toBe(true);
    });

    it('should include recurrence info (secondary) when event has recurrence', async () => {
      mockFormatEventTime.mockResolvedValue({ 
        primary: '2025/01/01 至 2025/01/31',
        secondary: '共 31 次，每日 10:00 - 11:00'
      });
      
      const event = {
        summary: 'Daily Standup',
        start: { dateTime: '2025-01-01T10:00:00Z' },
        end: { dateTime: '2025-01-01T11:00:00Z' },
        recurrence: ['RRULE:FREQ=DAILY;COUNT=31'],
      };

      const bubble = await createEventFlexBubble(event, 'Header');

      const bodyContents = bubble.body?.contents || [];
      // Should have separator and recurrence box when secondary is present
      const hasRecurrenceInfo = bodyContents.some((c: any) => 
        c.type === 'box' && JSON.stringify(c).includes('共 31 次')
      );
      expect(hasRecurrenceInfo).toBe(true);
      
      // Should also have the "重複" label
      const hasRecurrenceLabel = bodyContents.some((c: any) => 
        JSON.stringify(c).includes('重複')
      );
      expect(hasRecurrenceLabel).toBe(true);
    });

    it('should include modify and delete buttons when event has id and calendarId', async () => {
      mockFormatEventTime.mockResolvedValue({ primary: '2025年1月1日 10:00' });
      
      const event = {
        id: 'event-123',
        summary: 'Team Meeting',
        start: { dateTime: '2025-01-01T10:00:00Z' },
        organizer: { email: 'calendar@test.com' },
        htmlLink: 'https://calendar.google.com/event/123',
      };

      const bubble = await createEventFlexBubble(event, 'Header');

      const footerContents = bubble.footer?.contents || [];
      expect(footerContents.length).toBe(3); // View link + Modify + Delete
      
      const actions = footerContents.map((c: any) => c.action);
      expect(actions).toContainEqual(expect.objectContaining({
        type: 'uri',
        label: '在 Google 日曆中查看',
        uri: 'https://calendar.google.com/event/123',
      }));
      expect(actions).toContainEqual(expect.objectContaining({
        type: 'postback',
        label: '修改活動',
        data: 'action=modify&eventId=event-123&calendarId=calendar@test.com',
      }));
      expect(actions).toContainEqual(expect.objectContaining({
        type: 'postback',
        label: '刪除活動',
        data: 'action=delete&eventId=event-123&calendarId=calendar@test.com',
      }));
    });

    it('should handle event without title gracefully', async () => {
      mockFormatEventTime.mockResolvedValue({ primary: '2025年1月1日' });
      
      const event = {
        start: { dateTime: '2025-01-01T10:00:00Z' },
      };

      const bubble = await createEventFlexBubble(event, 'Header');

      expect(bubble.body?.contents[0]).toMatchObject({
        text: '無標題',
      });
    });

    it('should handle all-day event with date format', async () => {
      mockFormatEventTime.mockResolvedValue({ primary: '2025年1月1日 (全天)' });
      
      const event = {
        summary: 'Holiday',
        start: { date: '2025-01-01' },
        end: { date: '2025-01-02' },
      };

      const bubble = await createEventFlexBubble(event, '新增活動');

      expect(mockFormatEventTime).toHaveBeenCalledWith(expect.objectContaining({
        allDay: true,
      }));
    });
  });
});

