
import * as XLSX from 'xlsx';
import { CalendarEvent } from '../services/geminiService';

/**
 * Normalizes various time string formats into a standard HH:mm-HH:mm format.
 * @param timeStr The raw time string (e.g., "1430-22", "8301600", "09-1630").
 * @returns A normalized time string like "14:30-22:00".
 */
function normalizeTimeFormat(timeStr: string): string | null {
  const cleanTime = String(timeStr).replace(/[-\s]/g, '');

  // Format: 8301600 (7 digits) -> 08:30-16:00
  if (/^\d{7}$/.test(cleanTime)) {
    return `0${cleanTime.slice(0, 1)}:${cleanTime.slice(1, 3)}-${cleanTime.slice(3, 5)}:${cleanTime.slice(5, 7)}`;
  }

  // Format: 08301600 (8 digits) -> 08:30-16:00
  if (/^\d{8}$/.test(cleanTime)) {
    return `${cleanTime.slice(0, 2)}:${cleanTime.slice(2, 4)}-${cleanTime.slice(4, 6)}:${cleanTime.slice(6, 8)}`;
  }
  
  // Format: 1430-22, 09-1630, 8-12
  if (String(timeStr).includes('-')) {
    const [start, end] = String(timeStr).split('-').map(s => s.trim());

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
 * Universal parser for shift schedules from a 2D data grid.
 * Handles both text-based shifts (e.g., "早班") and time-code shifts (e.g., "1430-22").
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

        switch (shiftValue) {
          case '早班':
            startTime = '09:00';
            endTime = '17:00';
            title = `${personName} 早班`;
            break;
          case '晚班':
            startTime = '14:00';
            endTime = '22:00';
            title = `${personName} 晚班`;
            break;
          case '早接菜':
            startTime = '07:00';
            endTime = '15:00';
            title = `${personName} 早接菜`;
            break;
          default:
            const normalizedTime = normalizeTimeFormat(shiftValue);
            if (!normalizedTime) {
                continue;
            }

            [startTime, endTime] = normalizedTime.split('-');
            const startHour = parseInt(startTime.split(':')[0], 10);

            if (startHour < 9) {
              title = `${personName} 早接菜`;
            } else if (startHour < 12) {
              title = `${personName} 早班`;
            } else {
              title = `${personName} 晚班`;
            }
            break;
        }
        events.push({
          title: title,
          start: `${startDateStr}T${startTime}:00+08:00`,
          end: `${startDateStr}T${endTime}:00+08:00`,
          allDay: false,
          recurrence: null,
          reminder: 30,
          calendarId: 'primary',
        });
      }
    }
  }
  return events;
};

/**
 * Parses an XLSX buffer into calendar events using the universal parser.
 */
export const parseXlsxToEvents = (xlsxBuffer: Buffer, personName: string): CalendarEvent[] => {
  try {
    const workbook = XLSX.read(xlsxBuffer, { type: 'buffer' });
    if (!workbook.SheetNames || workbook.SheetNames.length === 0) {
        throw new Error('Invalid file: No sheets found.');
    }
    const sheetName = workbook.SheetNames[0];
    const sheet = workbook.Sheets[sheetName];
    // Use `defval: ''` to ensure empty cells are not skipped
    const data = XLSX.utils.sheet_to_json<(string | number)[]>(sheet, { header: 1, defval: '' });
    
    if (!data || data.length === 0) {
        return [];
    }
    return universalShiftParser(data, personName);
  } catch (e: any) {
    console.error(`[parseXlsxToEvents] Error: ${e.message}`);
    throw new Error('Failed to process XLSX file.');
  }
};

/**
 * Parses a CSV string into calendar events using the universal parser.
 */
export const parseCsvToEvents = (csvContent: string, personName:string): CalendarEvent[] => {
    try {
        // Use XLSX to read CSV content, it's robust
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
        return universalShiftParser(data, personName);
    } catch (e: any) {
        console.error(`[parseCsvToEvents] Error: ${e.message}`);
        throw new Error('Failed to process CSV file.');
    }
};
