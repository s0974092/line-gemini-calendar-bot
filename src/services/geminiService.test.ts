import {
  parseTextToCalendarEvent,
  parseRecurrenceEndCondition,
  translateRruleToHumanReadable,
} from './geminiService';
import { GoogleGenerativeAI } from '@google/generative-ai';

// Create a mock function that we can control and inspect
const mockGenerateContent = jest.fn();

// Mock the entire '@google/generative-ai' module using a factory function
jest.mock('@google/generative-ai', () => {
  return {
    GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
      getGenerativeModel: jest.fn().mockImplementation(() => ({
        generateContent: mockGenerateContent,
      })),
    })),
  };
});

describe('geminiService', () => {
  beforeEach(() => {
    mockGenerateContent.mockClear();
    (GoogleGenerativeAI as jest.Mock).mockClear();
  });

  // --- Tests for parseTextToCalendarEvent ---
  describe('parseTextToCalendarEvent', () => {
    const baseExpected = {
      allDay: false,
      recurrence: null,
      reminder: 30,
      calendarId: 'primary',
    };

    test('(A-1) should parse a simple event correctly', async () => {
      const mockResponse = { title: '開會', start: '2025-08-30T09:00:00+08:00', end: '2025-08-30T10:00:00+08:00' };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify({ ...baseExpected, ...mockResponse }) } });
      const result = await parseTextToCalendarEvent('明天早上9點開會');
      expect(result).toEqual({ ...baseExpected, ...mockResponse });
    });

    test('(A-2) should handle a specific date', async () => {
      const mockResponse = { title: '跟John面試', start: '2025-09-15T15:00:00+08:00', end: '2025-09-15T16:00:00+08:00' };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify({ ...baseExpected, ...mockResponse }) } });
      const result = await parseTextToCalendarEvent('9月15號下午三點跟John面試');
      expect(result).toEqual({ ...baseExpected, ...mockResponse });
    });

    test('(A-3) should handle events with a specific time range', async () => {
      const mockResponse = { title: '教育訓練', start: '2025-09-04T14:00:00+08:00', end: '2025-09-04T16:00:00+08:00' };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify({ ...baseExpected, ...mockResponse }) } });
      const result = await parseTextToCalendarEvent('週四下午2點到4點的教育訓練');
      expect(result).toEqual({ ...baseExpected, ...mockResponse });
    });

    test('(A-4) should handle simple recurring events', async () => {
      const mockResponse = { title: '站立會議', start: '2025-09-01T09:00:00+08:00', end: '2025-09-01T10:00:00+08:00', recurrence: 'RRULE:FREQ=WEEKLY;BYDAY=MO' };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify({ ...baseExpected, ...mockResponse, allDay: false }) } });
      const result = await parseTextToCalendarEvent('每週一早上9點的站立會議');
      expect(result).toEqual({ ...baseExpected, ...mockResponse, allDay: false });
    });

    test('(A-5) should handle all-day events', async () => {
      const mockResponse = { title: '國慶日放假', start: '2025-10-10T00:00:00+08:00', end: '2025-10-11T00:00:00+08:00', allDay: true };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify({ ...baseExpected, ...mockResponse }) } });
      const result = await parseTextToCalendarEvent('10月10號國慶日放假');
      expect(result).toEqual({ ...baseExpected, ...mockResponse });
    });

    test('(A-6) should handle a multi-day all-day event', async () => {
      const mockResponse = { title: '出差', start: '2025-09-01T00:00:00+08:00', end: '2025-09-04T00:00:00+08:00', allDay: true };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify({ ...baseExpected, ...mockResponse }) } });
      const result = await parseTextToCalendarEvent('下週一到下週三出差');
      expect(result).toEqual({ ...baseExpected, ...mockResponse });
    });

    test('(B-1) should apply a default duration for events with no end time', async () => {
      const mockResponse = { title: '去看牙醫', start: '2025-08-29T16:00:00+08:00', end: '2025-08-29T17:00:00+08:00' };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify({ ...baseExpected, ...mockResponse }) } });
      const result = await parseTextToCalendarEvent('今天下午4點要去看牙醫');
      expect(result).toEqual({ ...baseExpected, ...mockResponse });
    });

    test('(B-2) should handle vague time of day', async () => {
      const mockResponse = { title: '跟家人吃飯', start: '2025-09-06T19:00:00+08:00', end: '2025-09-06T20:00:00+08:00' };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify({ ...baseExpected, ...mockResponse }) } });
      const result = await parseTextToCalendarEvent('週六晚上跟家人吃飯');
      expect(result).toEqual({ ...baseExpected, ...mockResponse });
    });

    test('(B-3) should handle complex sentences', async () => {
      const mockResponse = { title: '客戶訪談', start: '2025-09-05T14:00:00+08:00', end: '2025-09-05T15:30:00+08:00' };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify({ ...baseExpected, ...mockResponse }) } });
      const result = await parseTextToCalendarEvent('對了，別忘了下週五要幫我預約下午兩點的客戶訪談，大概一個半小時');
      expect(result).toEqual({ ...baseExpected, ...mockResponse });
    });

    test('(B-4) should handle year change', async () => {
      const mockResponse = { title: '員工旅遊', start: '2026-01-05T00:00:00+08:00', end: '2026-01-06T00:00:00+08:00', allDay: true };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify({ ...baseExpected, ...mockResponse }) } });
      const result = await parseTextToCalendarEvent('明年1月5號員工旅遊');
      expect(result).toEqual({ ...baseExpected, ...mockResponse });
    });

    test('(B-5) should handle events with missing titles by returning a null title', async () => {
      const mockResponse = { title: null, start: '2025-08-30T15:00:00+08:00', end: '2025-08-30T16:00:00+08:00' };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify({ ...baseExpected, ...mockResponse }) } });
      const result = await parseTextToCalendarEvent('明天下午三點');
      expect(result).toEqual({ ...baseExpected, ...mockResponse });
    });

    test('(C-2) should return an error object for non-event text', async () => {
      const mockResponse = { error: 'Not a calendar event.' };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });
      const result = await parseTextToCalendarEvent('你好');
      expect(result).toEqual(mockResponse);
    });
  });

  // --- Tests for parseRecurrenceEndCondition ---
  describe('parseRecurrenceEndCondition', () => {
    test('should correctly parse a COUNT end condition', async () => {
      const mockResponse = { updatedRrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10' };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });
      const result = await parseRecurrenceEndCondition('重複10次', 'RRULE:FREQ=WEEKLY;BYDAY=MO', '2025-08-29T09:00:00+08:00');
      expect(result).toEqual(mockResponse);
    });

    test('should correctly parse an UNTIL end condition', async () => {
      const mockResponse = { updatedRrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO;UNTIL=20251231T235959Z' };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });
      const result = await parseRecurrenceEndCondition('直到年底', 'RRULE:FREQ=WEEKLY;BYDAY=MO', '2025-08-29T09:00:00+08:00');
      expect(result).toEqual(mockResponse);
    });
  });

  // --- Tests for translateRruleToHumanReadable ---
  describe('translateRruleToHumanReadable', () => {
    test('should correctly translate a simple weekly RRULE', async () => {
      const mockResponse = { description: '每週的星期一' };
      mockGenerateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });
      const result = await translateRruleToHumanReadable('RRULE:FREQ=WEEKLY;BYDAY=MO');
      expect(result).toEqual(mockResponse);
    });
  });
});