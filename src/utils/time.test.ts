import { formatEventTime, getConciseRecurrenceDescription } from './time';
import { CalendarEvent } from '../services/geminiService';

// Mock geminiService to control translateRruleToHumanReadable behavior
jest.mock('../services/geminiService', () => ({
  ...jest.requireActual('../services/geminiService'),
  translateRruleToHumanReadable: jest.fn(),
}));

const mockTranslateRruleToHumanReadable = require('../services/geminiService').translateRruleToHumanReadable;

describe('time.ts', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // Mock Date to control time for consistent test results
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2025-01-01T12:00:00Z')); // Set a fixed date for consistency
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  describe('formatEventTime', () => {
    it('should return "時間未定" if event start is not provided', async () => {
      const event: Partial<CalendarEvent> = {};
      const result = await formatEventTime(event);
      expect(result).toEqual({ primary: '時間未定' });
    });

    it('should format an all-day event correctly', async () => {
      const event: Partial<CalendarEvent> = {
        start: '2025-01-01T00:00:00Z',
        allDay: true,
      };
      const result = await formatEventTime(event);
      expect(result).toEqual({ primary: '2025年1月1日 (全天)' });
    });

    it('should format a single-day event with start and end time correctly', async () => {
      const event: Partial<CalendarEvent> = {
        start: '2025-01-01T10:00:00Z',
        end: '2025-01-01T11:00:00Z',
      };
      const result = await formatEventTime(event);
      expect(result).toEqual({ primary: '2025年1月1日 18:00 - 19:00' }); // Adjust for Asia/Taipei timezone
    });

    it('should format a multi-day event correctly', async () => {
      const event: Partial<CalendarEvent> = {
        start: '2025-01-01T10:00:00Z',
        end: '2025-01-02T11:00:00Z',
      };
      const result = await formatEventTime(event);
      expect(result).toEqual({ primary: '2025年1月1日 18:00 - 2025年1月2日 19:00' });
    });

    it('should format a recurring event with UNTIL correctly', async () => {
      mockTranslateRruleToHumanReadable.mockResolvedValue({ description: '每週一' });
      const event: Partial<CalendarEvent> = {
        start: '2025-01-06T10:00:00Z', // A Monday
        end: '2025-01-06T11:00:00Z',
        recurrence: 'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20250127T160000Z',
      };
      const result = await formatEventTime(event);
      expect(result).toEqual({
        primary: '2025/01/06 至 2025/01/27',
        secondary: '共 4 次，每週一 18:00 - 19:00',
      });
    });

    it('should format a recurring event with COUNT correctly', async () => {
      mockTranslateRruleToHumanReadable.mockResolvedValue({ description: '每日' });
      const event: Partial<CalendarEvent> = {
        start: '2025-01-01T09:00:00Z',
        end: '2025-01-01T10:00:00Z',
        recurrence: 'RRULE:FREQ=DAILY;COUNT=5',
      };
      const result = await formatEventTime(event);
      expect(result).toEqual({
        primary: '2025/01/01 至 2025/01/05',
        secondary: '共 5 次，每日 17:00 - 18:00',
      });
    });

    it('should format a recurring event without UNTIL or COUNT correctly', async () => {
      mockTranslateRruleToHumanReadable.mockResolvedValue({ description: '每週' });
      const event: Partial<CalendarEvent> = {
        start: '2025-01-01T10:00:00Z',
        end: '2025-01-01T11:00:00Z',
        recurrence: 'RRULE:FREQ=WEEKLY',
      };
      const result = await formatEventTime(event);
      expect(result).toEqual({
        primary: '每週',
        secondary: '18:00 - 19:00',
      });
    });

    it('should handle recurring event with empty allOccurrences gracefully', async () => {
      mockTranslateRruleToHumanReadable.mockResolvedValue({ description: '每週' });
      // Create an RRULE that results in no occurrences within the given time frame
      const event: Partial<CalendarEvent> = {
        start: '2025-01-01T10:00:00Z',
        end: '2025-01-01T11:00:00Z',
        recurrence: 'RRULE:FREQ=DAILY;COUNT=0',
      };
      const result = await formatEventTime(event);
      expect(result).toEqual({
        primary: '每週',
        secondary: '18:00 - 19:00',
      });
    });

    it('should format a single-day event with only start time correctly', async () => {
      const event: Partial<CalendarEvent> = {
        start: '2025-01-01T10:00:00Z',
      };
      const result = await formatEventTime(event);
      expect(result).toEqual({ primary: '2025年1月1日 18:00' });
    });
  });

  describe('getConciseRecurrenceDescription', () => {
    it('should return empty string if event start or recurrence is not provided', async () => {
      const event1: Partial<CalendarEvent> = { recurrence: 'RRULE:FREQ=DAILY' };
      const event2: Partial<CalendarEvent> = { start: '2025-01-01T10:00:00Z' };
      const event3: Partial<CalendarEvent> = {};

      expect(await getConciseRecurrenceDescription(event1)).toBe('');
      expect(await getConciseRecurrenceDescription(event2)).toBe('');
      expect(await getConciseRecurrenceDescription(event3)).toBe('');
    });

    it('should return empty string if recurrence is an empty string', async () => {
      const event: Partial<CalendarEvent> = {
        start: '2025-01-01T10:00:00Z',
        recurrence: '',
      };
      expect(await getConciseRecurrenceDescription(event)).toBe('');
    });

    it('should call translateRruleToHumanReadable and return its description', async () => {
      mockTranslateRruleToHumanReadable.mockResolvedValue({ description: '每週一' });
      const event: Partial<CalendarEvent> = {
        start: '2025-01-01T10:00:00Z',
        recurrence: 'RRULE:FREQ=WEEKLY;BYDAY=MO',
      };
      expect(await getConciseRecurrenceDescription(event)).toBe('每週一');
      expect(mockTranslateRruleToHumanReadable).toHaveBeenCalledWith('RRULE:FREQ=WEEKLY;BYDAY=MO');
    });

    it('should handle recurrence as an array and return its description', async () => {
      mockTranslateRruleToHumanReadable.mockResolvedValue({ description: '每週二' });
      const event: Partial<CalendarEvent> = {
        start: '2025-01-01T10:00:00Z',
        recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=TU'],
      };
      expect(await getConciseRecurrenceDescription(event)).toBe('每週二');
      expect(mockTranslateRruleToHumanReadable).toHaveBeenCalledWith('RRULE:FREQ=WEEKLY;BYDAY=TU');
    });

    it('should log error and return fallback if translateRruleToHumanReadable returns no description', async () => {
      mockTranslateRruleToHumanReadable.mockResolvedValue({ someOtherField: 'value' });
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const event: Partial<CalendarEvent> = {
        start: '2025-01-01T10:00:00Z',
        recurrence: 'RRULE:FREQ=DAILY',
      };
      expect(await getConciseRecurrenceDescription(event)).toBe('重複性活動');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Failed to translate RRULE, Gemini returned:', { someOtherField: 'value' });
      consoleErrorSpy.mockRestore();
    });

    it('should log error and return fallback if translateRruleToHumanReadable throws an error', async () => {
      mockTranslateRruleToHumanReadable.mockRejectedValue(new Error('Gemini API error'));
      const consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
      const event: Partial<CalendarEvent> = {
        start: '2025-01-01T10:00:00Z',
        recurrence: 'RRULE:FREQ=DAILY',
      };
      expect(await getConciseRecurrenceDescription(event)).toBe('重複性活動');
      expect(consoleErrorSpy).toHaveBeenCalledWith('Error translating RRULE to human readable:', new Error('Gemini API error'));
      consoleErrorSpy.mockRestore();
    });
  });
});
