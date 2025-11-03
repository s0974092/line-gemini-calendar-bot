
import { RRule } from 'rrule';
import { CalendarEvent } from '../services/geminiService';
import { getRecurrenceEndDate, translateRruleToHumanReadable } from '../services/geminiService';

export interface FormattedTime {
  primary: string;
  secondary?: string;
}

export const formatEventTime = async (event: Partial<CalendarEvent>): Promise<FormattedTime> => {
  if (!event.start) return { primary: '時間未定' };

  // Recurring event logic
  if (event.recurrence) {
    const rruleString = Array.isArray(event.recurrence) ? event.recurrence[0] : event.recurrence;
    if (typeof rruleString === 'string' && rruleString) {
      const startDate = new Date(event.start);
      const endDate = event.end ? new Date(event.end) : null;
      const startTimeStr = startDate.toLocaleTimeString('zh-TW', { timeStyle: 'short', hour12: false, timeZone: 'Asia/Taipei' });
      const endTimeStr = endDate ? endDate.toLocaleTimeString('zh-TW', { timeStyle: 'short', hour12: false, timeZone: 'Asia/Taipei' }) : '';
      
      const humanReadableRule = await getConciseRecurrenceDescription(event); // e.g., "每日"

      const untilMatch = rruleString.match(/UNTIL=/);
      const countMatch = rruleString.match(/COUNT=/);

      if (untilMatch || countMatch) {
        const ruleOptions = RRule.parseString(rruleString);
        ruleOptions.dtstart = startDate;
        const rule = new RRule(ruleOptions);

        const allOccurrences = rule.all();
        const count = allOccurrences.length;
        
        // If for some reason allOccurrences is empty, fallback to a simpler message
        if (count === 0) {
            return {
                primary: humanReadableRule,
                secondary: `${startTimeStr} - ${endTimeStr}`
            };
        }

        const firstDate = allOccurrences[0];
        const lastDate = allOccurrences[count - 1];

        const startDateStr = firstDate.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Taipei' });
        const lastDateStr = lastDate.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Taipei' });

        return {
          primary: `${startDateStr} 至 ${lastDateStr}`,
          secondary: `共 ${count} 次，${humanReadableRule} ${startTimeStr} - ${endTimeStr}`
        };
      }
      
      // Fallback for recurring events without UNTIL or COUNT
      return {
        primary: humanReadableRule,
        secondary: `${startTimeStr} - ${endTimeStr}`
      };
    }
  }

  // Non-recurring event logic
  const options: Intl.DateTimeFormatOptions = {
    timeZone: 'Asia/Taipei',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  };

  const startDate = new Date(event.start);

  if (event.allDay) {
    return { primary: `${startDate.toLocaleDateString('zh-TW', { ...options, hour: undefined, minute: undefined })} (全天)` };
  }

  const endDate = event.end ? new Date(event.end) : null;
  const startTimeStr = startDate.toLocaleTimeString('zh-TW', { timeStyle: 'short', hour12: false, timeZone: 'Asia/Taipei' });

  if (endDate) {
    const endTimeStr = endDate.toLocaleTimeString('zh-TW', { timeStyle: 'short', hour12: false, timeZone: 'Asia/Taipei' });
    if (startDate.toDateString() === endDate.toDateString()) {
      return { primary: `${startDate.toLocaleDateString('zh-TW', { dateStyle: 'long', timeZone: 'Asia/Taipei' })} ${startTimeStr} - ${endTimeStr}` };
    } else {
      return { primary: `${startDate.toLocaleString('zh-TW', options)} - ${endDate.toLocaleString('zh-TW', options)}` };
    }
  }

  return { primary: `${startDate.toLocaleString('zh-TW', options)}` };
};

export const getConciseRecurrenceDescription = async (event: Partial<CalendarEvent>): Promise<string> => {
  const { start, recurrence } = event;
  if (!start || !recurrence) return '';

  const rruleString = Array.isArray(recurrence) ? recurrence[0] : recurrence;
  if (typeof rruleString !== 'string' || rruleString === '') return '';

  try {
    const result = await translateRruleToHumanReadable(rruleString);
    if ('description' in result) {
      return result.description;
    }
    console.error('Failed to translate RRULE, Gemini returned:', result);
    return '重複性活動'; // Fallback
  } catch (error) {
    console.error('Error translating RRULE to human readable:', error);
    return '重複性活動'; // Fallback
  }
};
