
import * as XLSX from 'xlsx';
import { parseXlsxToEvents, parseCsvToEvents } from './excelParser';

describe('excelParser', () => {
  afterEach(() => {
    jest.restoreAllMocks();
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

    it('should parse a valid XLSX buffer', () => {
      const sheetData = [['日期', '10/1'], [personName, '早班']];
      const workbook = XLSX.utils.book_new();
      const sheet = XLSX.utils.aoa_to_sheet(sheetData);
      XLSX.utils.book_append_sheet(workbook, sheet, 'Sheet1');
      const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
      const events = parseXlsxToEvents(buffer, personName);
      expect(events).toHaveLength(1);
      expect(events[0].start).toContain('-10-01T09:00:00');
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
});
