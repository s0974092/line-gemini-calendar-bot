import * as XLSX from 'xlsx';
import { CalendarEvent } from '../services/geminiService';

/**
 * Normalizes various time string formats into a standard HH:mm-HH:mm format.
 * @param timeStr The raw time string (e.g., "14:30–22:00", "1430-22", "8301600", "09-1630").
 * @returns A normalized time string like "14:30-22:00".
 */
export function normalizeTimeFormat(timeStr: string): string | null {
  // Normalize different dash characters (en-dash, em-dash) to a standard hyphen
  const normalizedDashStr = String(timeStr).replace(/[–—]/g, '-').trim();

  // Priority 1: Handle "HH:mm-HH:mm" format directly
  if (/^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(normalizedDashStr)) {
    return normalizedDashStr;
  }

  const cleanTime = normalizedDashStr.replace(/[-\s]/g, '');

  // Format: 8301600 (7 digits) -> 08:30-16:00
  if (/^\d{7}$/.test(cleanTime)) {
    return `0${cleanTime.slice(0, 1)}:${cleanTime.slice(1, 3)}-${cleanTime.slice(3, 5)}:${cleanTime.slice(5, 7)}`;
  }

  // Format: 08301600 (8 digits) -> 08:30-16:00
  if (/^\d{8}$/.test(cleanTime)) {
    return `${cleanTime.slice(0, 2)}:${cleanTime.slice(2, 4)}-${cleanTime.slice(4, 6)}:${cleanTime.slice(6, 8)}`;
  }
  
  // Format: 1430-22, 09-1630, 8-12
  if (normalizedDashStr.includes('-')) {
    const [start, end] = normalizedDashStr.split('-').map(s => s.trim());

    // Add validation to ensure parts are numeric
    if (!/^\d+$/.test(start) || !/^\d+$/.test(end)) {
      return null;
    }

    const formatPart = (part: string): string => {
      // Handles formats like "1430" or "830"
      if (part.length > 2) {
        return `${part.slice(0, -2)}:${part.slice(-2)}`;
      }
      // Handles formats like "8", "12", "22"
      return `${part.padStart(2, '0')}:00`;
    };

    return `${formatPart(start)}-${formatPart(end)}`;
  }

  return null; // Return null if no format is matched
}

/**
 * [WIDE FORMAT PARSER]
 * Parses shift schedules from a "wide" 2D data grid where names are in a column and dates are in a row.
 * @param data The 2D array representing the sheet data.
 * @param personName The name of the person to filter for.
 * @returns An array of CalendarEvent objects.
 */
export const universalShiftParser = (data: (string | number)[][], personName: string): CalendarEvent[] => {
  const events: CalendarEvent[] = [];
  const currentYear = new Date().getFullYear();
  const normalizedPersonName = personName.normalize('NFC');

  for (let i = 0; i < data.length; i++) {
    const row = data[i];
    const nameColumnIndex = row.findIndex(cell => {
      const cellStr = String(cell).trim().normalize('NFC');
      return cellStr === normalizedPersonName;
    });

    if (nameColumnIndex !== -1) {
      const dateRow = data[i - 1];
      if (!dateRow) {
        continue;
      }

      for (let j = 0; j < row.length; j++) {
        const shiftValue = String(row[j]).trim();
        const dateCell = dateRow[j];
        let dateStr: string;

        if (typeof dateCell === 'number' && dateCell > 1) {
          dateStr = XLSX.SSF.format('m/d', dateCell);
        } else {
          dateStr = String(dateCell).trim();
        }

        if (!shiftValue || ['休', '假', '0', '-'].includes(shiftValue) || !dateStr.includes('/')) {
          continue;
        }

        const [month, day] = dateStr.split('/').map(Number);
        if (isNaN(month) || isNaN(day)) {
            continue;
        }
        
        const year = (month < new Date().getMonth() + 1) ? currentYear + 1 : currentYear;
        const startDateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;

        let title: string;
        let startTime: string;
        let endTime: string;

        const normalizedTime = normalizeTimeFormat(shiftValue);

        if (normalizedTime) {
            [startTime, endTime] = normalizedTime.split('-');
        } else {
            switch (shiftValue) {
                case '早班': startTime = '09:00'; endTime = '17:00'; break;
                case '晚班': startTime = '14:00'; endTime = '22:00'; break;
                case '早接菜': startTime = '07:00'; endTime = '15:00'; break;
                default: continue; 
            }
        }
        
        const startHour = parseInt(startTime.split(':')[0], 10);
        if (startHour < 9) {
            title = `${personName} 早接菜`;
        } else if (shiftValue === '晚班' || startHour >= 12) {
            title = `${personName} 晚班`;
        } else {
            title = `${personName} 早班`;
        }

        events.push({
          title: title,
          start: `${startDateStr}T${startTime}:00+08:00`,
          end: `${startDateStr}T${endTime}:00+08:00`,
          allDay: false,
          recurrence: null,
          calendarId: 'primary',
        });
      }
    }
  }
  return events;
};

/**
 * [FORMAT DETECTOR - LONG]
 * Detects if the provided sheet data is in "long" format by checking headers for common aliases.
 * @param data The 2D array representing the sheet data.
 * @returns True if it's a long format, false otherwise.
 */
const isLongFormat = (data: (string | number)[][]): boolean => {
    if (!data || data.length === 0) {
        return false;
    }
    const headers = data[0].map(h => String(h).trim());
    
    const hasName = headers.some(h => ['姓名', '名字', '員工'].includes(h));
    const hasDate = headers.some(h => ['日期'].includes(h));
    return hasName && hasDate;
};

/**
 * [FORMAT DETECTOR - VERTICAL]
 * Detects a vertical format where row 0 is a title and row 1 contains headers.
 * @param data The 2D array representing the sheet data.
 * @returns True if it's a vertical format, false otherwise.
 */
const isVerticalFormat = (data: (string | number)[][]): boolean => {
    if (!data || data.length < 2) {
        return false;
    }
    const headers = data[1].map(h => String(h).trim()); // Check the SECOND row for headers
    const hasDate = headers.some(h => ['日期'].includes(h));
    const hasShiftType = headers.some(h => ['班別', '班次'].includes(h));

    const firstRow = data[0];
    const isTitleRow = firstRow.length > 0 && (firstRow[1] === '' || firstRow[1] === undefined) && (firstRow[2] === '' || firstRow[2] === undefined);

    return isTitleRow && hasDate && hasShiftType;
};


/**
 * [LONG FORMAT PARSER]
 * Parses a "long" or "tidy" format schedule from a 2D data grid where each row is a single shift record.
 * @param data The 2D array representing the sheet data.
 * @param personName The name of the person to filter for.
 * @returns An array of CalendarEvent objects.
 */
const parseLongFormatToEvents = (data: (string | number)[][], personName: string): CalendarEvent[] => {
  const events: CalendarEvent[] = [];
  if (data.length < 2) return events; // At least one header and one data row

  const headers = data[0].map(h => String(h).trim());
  
  const findHeaderIndex = (aliases: string[]): number => {
    for (const alias of aliases) {
      const index = headers.indexOf(alias);
      if (index !== -1) return index;
    }
    for (const alias of aliases) {
        const index = headers.findIndex(h => h.includes(alias));
        if (index !== -1) return index;
    }
    return -1;
  };

  const nameIndex = findHeaderIndex(['姓名', '名字', '員工']);
  const dateIndex = findHeaderIndex(['日期']);
  const timeIndex = findHeaderIndex(['時間', '時段']);
  const shiftTypeIndex = findHeaderIndex(['班別', '班次']);

  if (nameIndex === -1 || dateIndex === -1) {
    console.warn(`[L-Parser] Required headers not found. NameIndex: ${nameIndex}, DateIndex: ${dateIndex}`);
    return events;
  }

  const currentYear = new Date().getFullYear();
  const normalizedPersonName = personName.normalize('NFC');

  for (let i = 1; i < data.length; i++) { // Start from 1 to skip header
    const row = data[i];

    if (row.every(cell => !cell)) {
        continue;
    }

    const nameCell = String(row[nameIndex] || '').trim().normalize('NFC');

    if (nameCell !== normalizedPersonName) {
      continue;
    }

    const dateCell = row[dateIndex];
    const timeValue = timeIndex > -1 ? String(row[timeIndex] || '').trim() : '';
    const shiftType = shiftTypeIndex > -1 ? String(row[shiftTypeIndex] || '').trim() : '';

    if (!dateCell || (!timeValue && !shiftType)) {
        continue;
    }
    
    let dateStr: string;
    if (typeof dateCell === 'number' && dateCell > 1) {
      dateStr = XLSX.SSF.format('m/d', dateCell);
    } else {
      dateStr = String(dateCell).trim();
    }
    
    let year, month, day;
    const dateParts = dateStr.split('/');
    if (dateParts.length === 3) {
        [year, month, day] = dateParts.map(Number);
    } else if (dateParts.length === 2) {
        [month, day] = dateParts.map(Number);
        year = (month < new Date().getMonth() + 1) ? currentYear + 1 : currentYear;
    } else {
        continue;
    }

    if (isNaN(year) || isNaN(month) || isNaN(day)) {
        continue;
    }

    const startDateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    let title: string;
    let startTime: string;
    let endTime: string;
    
    const normalizedTime = normalizeTimeFormat(timeValue);

    if (normalizedTime) {
      [startTime, endTime] = normalizedTime.split('-');
    } else {
      switch (shiftType) {
        case '早班': startTime = '09:00'; endTime = '17:00'; break;
        case '晚班': startTime = '14:00'; endTime = '22:00'; break;
        case '早接菜': startTime = '07:00'; endTime = '15:00'; break;
        default: 
            continue; 
      }
    }
    
    const startHour = parseInt(startTime.split(':')[0], 10);
    if (startHour < 9) {
        title = `${personName} 早接菜`;
    } else if (shiftType === '晚班' || startHour >= 12) {
        title = `${personName} 晚班`;
    } else {
        title = `${personName} 早班`;
    }

    events.push({
      title: title,
      start: `${startDateStr}T${startTime}:00+08:00`,
      end: `${startDateStr}T${endTime}:00+08:00`,
      allDay: false,
      recurrence: null,
      calendarId: 'primary',
    });
  }

  return events;
};

/**
 * [VERTICAL FORMAT PARSER]
 * Parses a "vertical" format where row 0 is the title, row 1 is headers, and data starts from row 2.
 * @param data The 2D array representing the sheet data (already sliced, with headers in row 0).
 * @param personName The name of the person requested by the user.
 * @returns An array of CalendarEvent objects.
 */
const parseVerticalFormatToEvents = (data: (string | number)[][], personName: string): CalendarEvent[] => {
  const events: CalendarEvent[] = [];
  if (data.length < 2) return events; // Needs at least a header and a data row

  const headers = data[0].map(h => String(h).trim());
  
  const findHeaderIndex = (aliases: string[]): number => {
    for (const alias of aliases) {
      const index = headers.indexOf(alias);
      if (index !== -1) return index;
    }
    for (const alias of aliases) {
      const index = headers.findIndex(h => h.includes(alias));
      if (index !== -1) return index;
    }
    return -1;
  };

  const dateIndex = findHeaderIndex(['日期']);
  const timeIndex = findHeaderIndex(['時間', '時段']);
  const shiftTypeIndex = findHeaderIndex(['班別', '班次']);

  if (dateIndex === -1) {
    console.warn(`[V-Parser] Required header "日期" not found.`);
    return events;
  }

  const currentYear = new Date().getFullYear();

  for (let i = 1; i < data.length; i++) { // Loop starts from 1 (skipping headers)
    const row = data[i];
    
    if (row.every(cell => !cell)) {
        continue;
    }

    const dateCell = row[dateIndex];
    const timeValue = timeIndex !== -1 ? String(row[timeIndex] || '').trim() : '';
    const shiftType = shiftTypeIndex !== -1 ? String(row[shiftTypeIndex] || '').trim() : '';

    if (!dateCell || (!timeValue && !shiftType)) {
      continue; 
    }
    
    let dateStr: string;
    if (typeof dateCell === 'number' && dateCell > 1) { // Handle Excel numeric dates
      dateStr = XLSX.SSF.format('m/d', dateCell);
    } else {
      dateStr = String(dateCell).trim();
    }
    
    let year, month, day;
    const dateParts = dateStr.split('/');
    if (dateParts.length === 3) {
        [year, month, day] = dateParts.map(Number);
    } else if (dateParts.length === 2) {
        [month, day] = dateParts.map(Number);
        year = (month < new Date().getMonth() + 1) ? currentYear + 1 : currentYear;
    } else {
        continue;
    }

    if (isNaN(year) || isNaN(month) || isNaN(day)) {
        continue;
    }

    const startDateStr = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    let title: string;
    let startTime: string;
    let endTime: string;
    
    const normalizedTime = normalizeTimeFormat(timeValue);

    if (normalizedTime) {
      [startTime, endTime] = normalizedTime.split('-');
    } else {
      switch (shiftType) {
        case '早班': startTime = '09:00'; endTime = '17:00'; break;
        case '晚班': startTime = '14:00'; endTime = '22:00'; break;
        case '早接菜': startTime = '07:00'; endTime = '15:00'; break;
        default: 
            continue; 
      }
    }
    
    const startHour = parseInt(startTime.split(':')[0], 10);
    if (startHour < 9) {
        title = `${personName} 早接菜`;
    } else if (shiftType === '晚班' || startHour >= 12) {
        title = `${personName} 晚班`;
    } else {
        title = `${personName} 早班`;
    }

    events.push({
      title: title,
      start: `${startDateStr}T${startTime}:00+08:00`,
      end: `${startDateStr}T${endTime}:00+08:00`,
      allDay: false,
      recurrence: null,
      calendarId: 'primary',
    });
  }
  return events;
};


/**
 * Parses an XLSX buffer into calendar events, automatically detecting the format.
 */
export const parseXlsxToEvents = (xlsxBuffer: Buffer, personName: string): CalendarEvent[] => {
  try {
    const workbook = XLSX.read(xlsxBuffer, { type: 'buffer' });
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
        throw new Error('Invalid file: No sheets found.');
    }
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    const data = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, defval: '' });
    
    if (!data || data.length === 0) {
        return [];
    }
    
    if (isLongFormat(data)) {
      console.log(`[parser] Detected Long Format for "${personName}".`);
      return parseLongFormatToEvents(data, personName);
    } else if (isVerticalFormat(data)) {
      console.log(`[parser] Detected Vertical Format for "${personName}".`);
      const transformedData = data.slice(1);
      return parseVerticalFormatToEvents(transformedData, personName);
    } else {
      console.log(`[parser] Detected Wide Format for "${personName}".`);
      return universalShiftParser(data, personName);
    }
  } catch (e: any) {
    console.error(`[parseXlsxToEvents] Error: ${e.message}`);
    throw new Error('Failed to process XLSX file.');
  }
};

/**
 * Parses a CSV string into calendar events, automatically detecting the format.
 */
export const parseCsvToEvents = (csvContent: string, personName:string): CalendarEvent[] => {
    try {
        const workbook = XLSX.read(csvContent, { type: 'string', raw: true });
        if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
            throw new Error('Invalid file: No sheets found.');
        }
        const sheetName = workbook.SheetNames[0];
        const sheet = workbook.Sheets[sheetName];
        const data = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, defval: '' });

        if (!data || data.length === 0) {
            return [];
        }

        if (isLongFormat(data)) {
          console.log(`[parser] Detected Long Format for "${personName}".`);
          return parseLongFormatToEvents(data, personName);
        } else if (isVerticalFormat(data)) {
          console.log(`[parser] Detected Vertical Format for "${personName}".`);
          const transformedData = data.slice(1);
          return parseVerticalFormatToEvents(transformedData, personName);
        } else {
          console.log(`[parser] Detected Wide Format for "${personName}".`);
          return universalShiftParser(data, personName);
        }
    } catch (e: any) {
        console.error(`[parseCsvToEvents] Error: ${e.message}`);
        throw new Error('Failed to process CSV file.');
    }
};