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
    mockGeminiApi.generateContent.mockReset();
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.useFakeTimers();
  });

  afterEach(() => {
    (console.warn as jest.Mock).mockRestore();
    (console.error as jest.Mock).mockRestore();
    jest.useRealTimers();
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

    it('Test Case 2.1: should override a timed event to all-day if text contains "全天"', async () => {
      const mockApiResponse = {
        type: 'create_event',
        event: {
          title: '全天會議',
          start: '2025-11-25T09:00:00+08:00', // Timed event from Gemini
          end: '2025-11-25T10:00:00+08:00',
          allDay: false,
        },
      };
      mockGeminiApi.generateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockApiResponse) } });

      const result = await classifyIntent('明天全天開會');

      expect(result.type).toBe('create_event');
      if (result.type === 'create_event') {
        expect(result.event.allDay).toBe(true);
        expect(result.event.start).toBe('2025-11-25');
        expect(result.event.end).toBe('2025-11-26');
      }
    });

    it('Test Case 2.2: should override a timed event to all-day if text contains "整天"', async () => {
      const mockApiResponse = {
        type: 'create_event',
        event: {
          title: '整天 offsite',
          start: '2025-11-25T09:00:00+08:00', // Timed event from Gemini
        },
      };
      mockGeminiApi.generateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockApiResponse) } });

      const result = await classifyIntent('明天整天 offsite');

      expect(result.type).toBe('create_event');
      if (result.type === 'create_event') {
        expect(result.event.allDay).toBe(true);
        expect(result.event.start).toBe('2025-11-25');
        expect(result.event.end).toBe('2025-11-26');
      }
    });

    it('Test Case 2.4: should not modify event if all-day keyword exists but start date is missing', async () => {
      const mockApiResponse = {
        type: 'create_event',
        event: {
          title: '一個沒有時間的事件',
        },
      };
      mockGeminiApi.generateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockApiResponse) } });

      const result = await classifyIntent('全天待命');

      expect(result).toEqual(mockApiResponse); // Should return the original object without crashing
    });
  });

  describe('parseTextToCalendarEvent', () => {
    it('should parse a simple event', async () => {
      const mockResponse = { title: 'Test Event' };
      mockGeminiApi.generateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });
      const result = await parseTextToCalendarEvent('Some text');
      expect(result).toEqual(mockResponse);
    });

    it('should parse an event with location and description', async () => {
      const mockResponse = {
        title: 'Team Meeting',
        start: '2025-09-09T10:00:00+08:00',
        end: '2025-09-09T11:00:00+08:00',
        location: 'Conference Room 5',
        description: 'Discuss Q3 results'
      };
      mockGeminiApi.generateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });
      const result = await parseTextToCalendarEvent('Tomorrow at 10am, team meeting in Conference Room 5 to discuss Q3 results');
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

    it('should parse event changes with location and description', async () => {
      const mockResponse = { 
        location: 'New Location',
        description: 'New Description'
      };
      mockGeminiApi.generateContent.mockResolvedValue({ response: { text: () => JSON.stringify(mockResponse) } });
      const result = await parseEventChanges('location to New Location, description to New Description');
      expect(result).toEqual(mockResponse);
    });

    it('should handle API errors gracefully', async () => {
      mockGeminiApi.generateContent.mockRejectedValue(new Error('API Error'));
      const result = await parseEventChanges('any');
      expect(result).toEqual({ error: 'Failed to parse event changes from text.' });
    });
  });

  describe('API Retry Logic', () => {
    // Test wrapper functions like parseTextToCalendarEvent which call the internal callGeminiText
    describe('callGeminiText', () => {
      it('Test Case 1.1: should retry on 503 error and succeed on the second attempt', async () => {
        const error503 = new Error('Service Unavailable');
        (error503 as any).status = 503;
        const mockSuccessResponse = { title: 'Success Event' };

        mockGeminiApi.generateContent
          .mockRejectedValueOnce(error503)
          .mockResolvedValueOnce({ response: { text: () => JSON.stringify(mockSuccessResponse) } });

        const promise = parseTextToCalendarEvent('Some text');
        await jest.advanceTimersByTimeAsync(2000); // Advance past the delay
        const result = await promise;

        expect(result).toEqual(mockSuccessResponse);
        expect(mockGeminiApi.generateContent).toHaveBeenCalledTimes(2);
        expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('retrying in 2000ms... (Attempt 1/3)'));
      });

      it('Test Case 1.2: should fail after exhausting all retries on 503 errors', async () => {
                  const error503 = new Error('Service Unavailable');
                  (error503 as any).status = 503;
                  mockGeminiApi.generateContent          .mockRejectedValueOnce(error503)
          .mockRejectedValueOnce(error503)
          .mockRejectedValueOnce(error503);

        const promise = parseTextToCalendarEvent('Some text');
        await jest.runAllTimersAsync();
        const result = await promise;

        expect(result).toEqual({ error: 'Failed to parse event from text.' });
        expect(mockGeminiApi.generateContent).toHaveBeenCalledTimes(3);
        expect(console.error).toHaveBeenCalledWith('Error calling Gemini Text API:', error503);
      });

      it('Test Case 1.3: should not retry on non-503 errors', async () => {
        const error400 = new Error('Bad Request');
        (error400 as any).status = 400;

        mockGeminiApi.generateContent.mockRejectedValueOnce(error400);

        const result = await parseTextToCalendarEvent('Some text');

        expect(result).toEqual({ error: 'Failed to parse event from text.' });
        expect(mockGeminiApi.generateContent).toHaveBeenCalledTimes(1);
        expect(console.warn).not.toHaveBeenCalled();
        expect(console.error).toHaveBeenCalledWith('Error calling Gemini Text API:', error400);
      });
    });

    // Test wrapper functions like parseImageToCalendarEvents which call the internal callGeminiVision
    describe('callGeminiVision', () => {
        it('Test Case 1.1: should retry on 503 error and succeed on the second attempt', async () => {
            const error503 = new Error('Service Unavailable');
            (error503 as any).status = 503;
            const mockSuccessResponse = { events: [{ title: 'Image Event' }] };
    
            mockGeminiApi.generateContent
              .mockRejectedValueOnce(error503)
              .mockResolvedValueOnce({ response: { text: () => JSON.stringify(mockSuccessResponse) } });
    
            const promise = parseImageToCalendarEvents('base64string', 'TestPerson');
            await jest.advanceTimersByTimeAsync(2000);
            const result = await promise;
    
            expect(result).toEqual(mockSuccessResponse);
            expect(mockGeminiApi.generateContent).toHaveBeenCalledTimes(2);
            expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('retrying in 2000ms... (Attempt 1/3)'));
        }, 20000);

        it('Test Case 1.2: should fail after exhausting all retries on 503 errors', async () => {
            const error503 = new Error('Service Unavailable');
            (error503 as any).status = 503;
    
            mockGeminiApi.generateContent
              .mockRejectedValueOnce(error503)
              .mockRejectedValueOnce(error503)
              .mockRejectedValueOnce(error503);
    
            const promise = parseImageToCalendarEvents('base64string', 'TestPerson');
            await jest.runAllTimersAsync();
            const result = await promise;
    
            expect(result).toEqual({ error: 'Failed to parse event from image.' });
            expect(mockGeminiApi.generateContent).toHaveBeenCalledTimes(3);
            expect(console.error).toHaveBeenCalledWith('Error calling Gemini Vision API:', error503);
        });

        it('Test Case 1.3: should not retry on non-503 errors', async () => {
            const error400 = new Error('Bad Request');
            (error400 as any).status = 400;
    
            mockGeminiApi.generateContent.mockRejectedValueOnce(error400);
    
            const result = await parseImageToCalendarEvents('base64string', 'TestPerson');
    
            expect(result).toEqual({ error: 'Failed to parse event from image.' });
            expect(mockGeminiApi.generateContent).toHaveBeenCalledTimes(1);
            expect(console.warn).not.toHaveBeenCalled();
            expect(console.error).toHaveBeenCalledWith('Error calling Gemini Vision API:', error400);
        });
    });
  });
});
