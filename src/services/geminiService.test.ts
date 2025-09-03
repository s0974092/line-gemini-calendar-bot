import {
  classifyIntent,
  parseImageToCalendarEvents,
  parseTextToCalendarEvent,
  parseRecurrenceEndCondition,
  translateRruleToHumanReadable,
  parseEventChanges,
} from './geminiService';

const mockGeminiApi = {
  generateContent: jest.fn(),
};

jest.mock('@google/generative-ai', () => ({
  GoogleGenerativeAI: jest.fn().mockImplementation(() => ({
    getGenerativeModel: jest.fn(() => ({
      generateContent: mockGeminiApi.generateContent,
    })),
  })),
}));

describe('geminiService', () => {
  beforeEach(() => {
    mockGeminiApi.generateContent.mockClear();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    (console.warn as jest.Mock).mockRestore();
  });

  describe('classifyIntent', () => {
    it('should correctly classify a query intent', async () => {
      const mockResponse = { type: 'query_event', timeMin: 'a', timeMax: 'b', query: 'c' };
      mockGeminiApi.generateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });
      const result = await classifyIntent('any');
      expect(result).toEqual(mockResponse);
    });

    it('should handle API errors gracefully', async () => {
      mockGeminiApi.generateContent.mockRejectedValue(new Error('API Error'));
      const result = await classifyIntent('any');
      expect(result).toEqual({ type: 'unknown', originalText: 'any' });
    });

    it('should return unknown if response is missing type property', async () => {
      const mockResponse = { query: 'test' }; // Missing 'type'
      mockGeminiApi.generateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });
      const result = await classifyIntent('any');
      expect(result).toEqual({ type: 'unknown', originalText: 'any' });
      expect(console.warn).toHaveBeenCalled();
    });
  });

  describe('parseTextToCalendarEvent', () => {
    it('should parse a simple event', async () => {
      const mockResponse = { title: 'Test Event' };
      mockGeminiApi.generateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });
      const result = await parseTextToCalendarEvent('Some text');
      expect(result).toEqual(mockResponse);
    });

    it('should handle API errors gracefully', async () => {
        mockGeminiApi.generateContent.mockRejectedValue(new Error('API Error'));
        const result = await parseTextToCalendarEvent('any');
        expect(result).toEqual({ error: 'Failed to parse event from text.' });
    });
  });

  describe('parseImageToCalendarEvents', () => {
    it('should parse events from an image', async () => {
        const mockResponse = { events: [{ title: 'Image Event' }] };
        mockGeminiApi.generateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });
        const result = await parseImageToCalendarEvents('base64string', 'TestPerson');
        expect(result).toEqual(mockResponse);
    });

    it('should handle API errors gracefully', async () => {
        mockGeminiApi.generateContent.mockRejectedValue(new Error('API Error'));
        const result = await parseImageToCalendarEvents('base64string', 'TestPerson');
        expect(result).toEqual({ error: 'Failed to parse event from image.' });
    });
  });

  describe('parseRecurrenceEndCondition', () => {
    it('should parse an end condition', async () => {
      const mockResponse = { updatedRrule: 'RRULE:FREQ=WEEKLY;BYDAY=MO;COUNT=10' };
      mockGeminiApi.generateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });
      const result = await parseRecurrenceEndCondition('Some text', 'RRULE:FREQ=WEEKLY;BYDAY=MO', '2025-01-01T10:00:00+08:00');
      expect(result).toEqual(mockResponse);
    });

    it('should handle API errors gracefully', async () => {
        mockGeminiApi.generateContent.mockRejectedValue(new Error('API Error'));
        const result = await parseRecurrenceEndCondition('any', 'any', 'any');
        expect(result).toEqual({ error: 'Failed to parse recurrence end condition.' });
    });
  });

  describe('translateRruleToHumanReadable', () => {
    it('should translate an RRULE', async () => {
      const mockResponse = { description: '每週一' };
      mockGeminiApi.generateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });
      const result = await translateRruleToHumanReadable('RRULE:FREQ=WEEKLY;BYDAY=MO');
      expect(result).toEqual(mockResponse);
    });

    it('should handle API errors gracefully', async () => {
        mockGeminiApi.generateContent.mockRejectedValue(new Error('API Error'));
        const result = await translateRruleToHumanReadable('any');
        expect(result).toEqual({ error: 'Failed to translate RRULE.' });
    });
  });

  describe('parseEventChanges', () => {
    it('should parse event changes from text', async () => {
      const mockResponse = { title: 'New Title' };
      mockGeminiApi.generateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });
      const result = await parseEventChanges('change title to New Title');
      expect(result).toEqual(mockResponse);
    });

    it('should handle API errors gracefully', async () => {
      mockGeminiApi.generateContent.mockRejectedValue(new Error('API Error'));
      const result = await parseEventChanges('any');
      expect(result).toEqual({ error: 'Failed to parse event changes from text.' });
    });
  });

  describe('callGeminiText with retry logic', () => {
    // This test is for an internal function, but we test it via an exported one.
    it('should retry on 503 error and succeed on the second attempt', async () => {
      const error503 = new Error('Service Unavailable');
      // Manually add the status property to the error object for the mock
      (error503 as any).status = 503;
      
      const mockSuccessResponse = { title: 'Success Event' };

      mockGeminiApi.generateContent
        .mockRejectedValueOnce(error503)
        .mockResolvedValueOnce({ response: { text: () => JSON.stringify(mockSuccessResponse) } });

      // We use parseTextToCalendarEvent to test the underlying callGeminiText
      const result = await parseTextToCalendarEvent('Some text');

      expect(result).toEqual(mockSuccessResponse);
      expect(mockGeminiApi.generateContent).toHaveBeenCalledTimes(2);
    });

    it('should fail after exhausting all retries on 503 errors', async () => {
      const error503 = new Error('Service Unavailable');
      (error503 as any).status = 503;

      mockGeminiApi.generateContent.mockRejectedValue(error503);

      // We use parseTextToCalendarEvent to test the underlying callGeminiText
      const result = await parseTextToCalendarEvent('Some text');

      expect(result).toEqual({ error: 'Failed to parse event from text.' });
      expect(mockGeminiApi.generateContent).toHaveBeenCalledTimes(3);
    });

    it('should not retry on non-503 errors', async () => {
      const error400 = new Error('Bad Request');
      (error400 as any).status = 400;

      mockGeminiApi.generateContent.mockRejectedValue(error400);
      
      // We use parseTextToCalendarEvent to test the underlying callGeminiText
      const result = await parseTextToCalendarEvent('Some text');

      expect(result).toEqual({ error: 'Failed to parse event from text.' });
      expect(mockGeminiApi.generateContent).toHaveBeenCalledTimes(1);
    });
  });

  describe('callGeminiVision with retry logic', () => {
    // This test is for an internal function, but we test it via an exported one.
    it('should retry on 503 error and succeed on the second attempt', async () => {
      const error503 = new Error('Service Unavailable');
      (error503 as any).status = 503;
      
      const mockSuccessResponse = { events: [{ title: 'Image Event' }] };

      mockGeminiApi.generateContent
        .mockRejectedValueOnce(error503)
        .mockResolvedValueOnce({ response: { text: () => JSON.stringify(mockSuccessResponse) } });

      // We use parseImageToCalendarEvents to test the underlying callGeminiVision
      const result = await parseImageToCalendarEvents('base64string', 'TestPerson');

      expect(result).toEqual(mockSuccessResponse);
      expect(mockGeminiApi.generateContent).toHaveBeenCalledTimes(2);
    });

    it('should fail after exhausting all retries on 503 errors', async () => {
      const error503 = new Error('Service Unavailable');
      (error503 as any).status = 503;

      mockGeminiApi.generateContent.mockRejectedValue(error503);

      // We use parseImageToCalendarEvents to test the underlying callGeminiVision
      const result = await parseImageToCalendarEvents('base64string', 'TestPerson');

      expect(result).toEqual({ error: 'Failed to parse event from image.' });
      expect(mockGeminiApi.generateContent).toHaveBeenCalledTimes(3);
    });

    it('should not retry on non-503 errors', async () => {
      const error400 = new Error('Bad Request');
      (error400 as any).status = 400;

      mockGeminiApi.generateContent.mockRejectedValue(error400);
      
      // We use parseImageToCalendarEvents to test the underlying callGeminiVision
      const result = await parseImageToCalendarEvents('base64string', 'TestPerson');

      expect(result).toEqual({ error: 'Failed to parse event from image.' });
      expect(mockGeminiApi.generateContent).toHaveBeenCalledTimes(1);
    });
  });
});
