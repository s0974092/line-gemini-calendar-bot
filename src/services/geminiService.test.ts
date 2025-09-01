import {
  parseTextToCalendarEvent,
  parseRecurrenceEndCondition,
  translateRruleToHumanReadable,
} from './geminiService';

const mockGenerateContent = jest.fn();
jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn(() => ({
      generateContent: mockGenerateContent,
    })),
  })),
}));

describe('geminiService', () => {
  beforeEach(() => {
    mockGenerateContent.mockClear();
  });

  describe('parseTextToCalendarEvent', () => {
    it('should parse a simple event', async () => {
      const mockResponse = {
        title: 'Test Event',
        start: '2025-01-01T10:00:00+08:00',
        end: '2025-01-01T11:00:00+08:00',
        allDay: false,
        recurrence: null,
        reminder: 30,
        calendarId: 'primary',
      };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });

      const result = await parseTextToCalendarEvent('Some text');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('parseRecurrenceEndCondition', () => {
    it('should parse an end condition', async () => {
      const mockResponse = { updatedRrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10' };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });

      const result = await parseRecurrenceEndCondition('Some text', 'RRULE:FREQ=WEEKLY;BYDAY=MO', '2025-01-01T10:00:00+08:00');
      expect(result).toEqual(mockResponse);
    });
  });

  describe('translateRruleToHumanReadable', () => {
    it('should translate an RRULE', async () => {
      const mockResponse = { description: '每週一' };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });

      const result = await translateRruleToHumanReadable('RRULE:FREQ=WEEKLY;BYDAY=MO');
      expect(result).toEqual(mockResponse);
    });
  });
});
