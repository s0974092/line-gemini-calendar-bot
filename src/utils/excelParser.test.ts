
import * as XLSX from 'xlsx';
import { parseXlsxToEvents, parseCsvToEvents, normalizeTimeFormat } from './excelParser';

describe('excelParser', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('normalizeTimeFormat', () => {
    it('should handle HH:mm-HH:mm with standard hyphen', () => {
        expect(normalizeTimeFormat('14:30-22:00')).toBe('14:30-22:00');
    });

    it('should handle HH:mm–HH:mm with en-dash', () => {
        expect(normalizeTimeFormat('09:00–17:00')).toBe('09:00-17:00');
    });
    
    it('should handle old format without colons like 1430-22', () => {
        expect(normalizeTimeFormat('1430-22')).toBe('14:30-22:00');
    });

    it('should handle 8-digit format like 08301600', () => {
        expect(normalizeTimeFormat('08301600')).toBe('08:30-16:00');
    });

    it('should handle 7-digit format like 8301600', () => {
        expect(normalizeTimeFormat('8301600')).toBe('08:30-16:00');
    });

    it('should return null for invalid format', () => {
        expect(normalizeTimeFormat('invalid-time')).toBeNull();
    });

    it('should correctly pad single-digit hours', () => {
        expect(normalizeTimeFormat('8-12')).toBe('08:00-12:00');
    });
  });

  describe('Core Parsing Logic', () => {
    const personName = '承君';

    it('should parse various shifts from CSV', () => {
      const csvContent = `日期,10/1,10/2,10/3,10/4
${personName},晚班,早班,假,1430-22`;
      const events = parseCsvToEvents(csvContent, personName);
      expect(events).toHaveLength(3);
      expect(events[0].start).toContain('-10-01T14:00:00');
      expect(events[1].start).toContain('-10-02T09:00:00');
      expect(events[2].start).toContain('-10-04T14:30:00');
    });

    it('should return an empty array if person is not found', () => {
      const csvContent = `日期,10/1\n${personName},早班`;
      const events = parseCsvToEvents(csvContent, '路人甲');
      expect(events).toEqual([]);
    });
  });

  describe('parseXlsxToEvents', () => {
    const personName = '承君';

    it('should parse a valid WIDE-format XLSX buffer', () => {
      const sheetData = [['日期', '10/1'], [personName, '早班']];
      const workbook = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet(sheetData);
      XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
      const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      const events = parseXlsxToEvents(buffer, personName);
      expect(events).toHaveLength(1);
      expect(events[0].start).toContain('-10-01T09:00:00');
    });

    it('should correctly parse a LONG-format XLSX file', () => {
      const sheetData = [
        ['姓名', '日期', '時間', '班別'],
        ['承君', '11/26', '09:00-17:00', '早班'],
        ['路人甲', '11/26', '09:00-17:00', '早班'],
        ['承君', '11/27', '14:00–22:00', '晚班'],
        ['承君', '11/28', '07:00-15:00', '早接菜'],
      ];
      const workbook = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet(sheetData);
      XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
      const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      
      const events = parseXlsxToEvents(buffer, '承君');
      expect(events).toHaveLength(3);
      expect(events[0].start).toContain('-11-26T09:00:00');
      expect(events[0].title).toBe('承君 早班');
      expect(events[1].start).toContain('-11-27T14:00:00');
      expect(events[1].title).toBe('承君 晚班');
      expect(events[2].start).toContain('-11-28T07:00:00');
      expect(events[2].title).toBe('承君 早接菜');
    });

    it('should correctly parse a VERTICAL-format XLSX file', () => {
      const sheetData = [
        ['承君', '', ''],
        ['日期', '班別', '時間'],
        ['11/24', '晚班', '14:30–22:00'],
        ['11/25', '早班', '9-17'],
        ['11/26', '早接菜', '07:00-15:00'],
      ];
       const workbook = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet(sheetData);
      XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
      const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

      const events = parseXlsxToEvents(buffer, '承君');
      expect(events).toHaveLength(3);
      expect(events[0].start).toContain('-11-24T14:30:00');
      expect(events[0].title).toBe('承君 晚班');
      expect(events[1].start).toContain('-11-25T09:00:00');
      expect(events[1].title).toBe('承君 早班');
      expect(events[2].start).toContain('-11-26T07:00:00');
      expect(events[2].title).toBe('承君 早接菜');
    });

    it('should throw an error if parsing internally fails', () => {
      jest.spyOn(XLSX.utils, 'sheet_to_json').mockImplementation(() => {
        throw new Error('Fake XLSX parsing error');
      });
      const sheetData = [['日期', '10/1'], [personName, '早班']];
      const workbook = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet(sheetData);
      XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
      const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      expect(() => parseXlsxToEvents(buffer, personName)).toThrow('Failed to process XLSX file.');
    });
  });

  describe('parseCsvToEvents', () => {
    const personName = '承君';

    it('should throw a generic error if parsing fails', () => {
      jest.spyOn(XLSX.utils, 'sheet_to_json').mockImplementation(() => {
        throw new Error('Fake sheet_to_json error');
      });
      const csvContent = `日期,10/1\n${personName},早班`;
      expect(() => parseCsvToEvents(csvContent, personName)).toThrow('Failed to process CSV file.');
    });

    it('should return an empty array for empty CSV content', () => {
      const events = parseCsvToEvents('', personName);
      expect(events).toEqual([]);
    });
  });

  describe('Parsing Edge Cases and Data Integrity', () => {
    const personName = '承君';

    it('should skip rows with invalid data and still parse valid ones', () => {
        const sheetData = [
            ['承君', '', ''],
            ['日期', '班別', '時間'],
            ['11/24', '晚班', '14:30–22:00'], // Valid
            ['N/A', '早班', '09:00-17:00'],    // Invalid Date
            ['11/26', '中班', ''],            // Unknown Shift Type
            [],                                // Empty Row
            ['11/27', '早接菜', ''],            // Valid (by shift type)
        ];
        const workbook = XLSX.utils.book_new();
        const sheet = XLSX.utils.aoa_to_sheet(sheetData);
        XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        const events = parseXlsxToEvents(buffer, personName);
        
        expect(events).toHaveLength(2); // Only the two valid rows should be parsed
        expect(events[0].start).toContain('-11-24T14:30:00');
        expect(events[1].start).toContain('-11-27T07:00:00');
    });

    it('should return an empty array if a required header is missing', () => {
        const sheetData = [
            ['承君', '', ''],
            ['班別', '時間'], // Missing '日期' header
            ['晚班', '14:30–22:00'],
        ];
        const workbook = XLSX.utils.book_new();
        const sheet = XLSX.utils.aoa_to_sheet(sheetData);
        XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        const events = parseXlsxToEvents(buffer, personName);
        
        expect(events).toHaveLength(0);
    });

    it('should return an empty array for an empty sheet', () => {
        const sheetData = [[]]; // Empty sheet
        const workbook = XLSX.utils.book_new();
        const sheet = XLSX.utils.aoa_to_sheet(sheetData);
        XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        const events = parseXlsxToEvents(buffer, personName);
        
        expect(events).toHaveLength(0);
    });

    it('should return an empty array for an unrecognized format', () => {
        const sheetData = [
            ['Header A', 'Header B', 'Header C'],
            ['Data 1', 'Data 2', 'Data 3'],
            ['Name:', '承君', ''], // Data that doesn't fit any pattern
        ];
        const workbook = XLSX.utils.book_new();
        const sheet = XLSX.utils.aoa_to_sheet(sheetData);
        XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
        const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });

        const events = parseXlsxToEvents(buffer, personName);
        
        expect(events).toHaveLength(0);
    });
  });
});
