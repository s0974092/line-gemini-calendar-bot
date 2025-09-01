import { google, calendar_v3 } from 'googleapis';
import { CalendarEvent } from './geminiService';

// --- 1. Custom Error for Duplicate Events ---
export class DuplicateEventError extends Error {
  public htmlLink?: string | null;

  constructor(message: string, htmlLink?: string | null) {
    super(message);
    this.name = 'DuplicateEventError';
    this.htmlLink = htmlLink;
  }
}

// --- 2. Authentication ---
const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
auth.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

export const calendar = google.calendar({ version: 'v3', auth });

// --- 3. Calendar Listing and Selection Logic ---

/**
 * Lists all of the user's calendars.
 */
export const listAllCalendars = async (): Promise<calendar_v3.Schema$CalendarListEntry[]> => {
  try {
    const response = await calendar.calendarList.list({
      showHidden: true, // Ensure we can see all calendars
    });

    if (response.data.items) {
      return response.data.items;
    }
    return [];
  } catch (error) {
    console.error('Error listing calendars:', error);
    throw new Error('Failed to list calendars.');
  }
};

/**
 * Represents a simplified calendar choice for the user.
 */
export interface CalendarChoice {
  id: string;
  summary: string;
}

/**
 * Generates a list of calendar choices for the user based on TARGET_CALENDAR_NAME.
 * Always includes the primary calendar, and up to 2 additional matching calendars.
 * @returns An array of CalendarChoice objects.
 */
export async function getCalendarChoicesForUser(): Promise<CalendarChoice[]> {
  const CALENDAR_CHOICE_LIMIT = 3; // Max 3 choices including primary
  const targetNamesString = process.env.TARGET_CALENDAR_NAME;
  const targetNames = targetNamesString ? targetNamesString.split(',').map(name => name.trim()).filter(name => name !== '') : [];

  const choices: CalendarChoice[] = [];
  let allUserCalendars: calendar_v3.Schema$CalendarListEntry[] = [];

  try {
    allUserCalendars = await listAllCalendars();
  } catch (error) {
    console.error('Failed to fetch user calendars, defaulting to primary.', error);
    // If listing fails, we can only offer primary
    choices.push({ id: 'primary', summary: '我的主要日曆' }); // Fallback
    return choices;
  }

  // 1. Add primary calendar first
  const primaryCalendar = allUserCalendars.find(cal => cal.primary);
  if (primaryCalendar) {
    choices.push({ id: primaryCalendar.id!, summary: primaryCalendar.summary || '我的主要日曆' });
  } else {
    // This case should ideally not happen, but as a fallback
    choices.push({ id: 'primary', summary: '我的主要日曆' });
  }

  // 2. Add other target calendars based on priority and limit
  for (const targetName of targetNames) {
    if (choices.length >= CALENDAR_CHOICE_LIMIT) {
      break; // Reached the limit
    }

    const foundCal = allUserCalendars.find(cal => cal.summary === targetName);
    if (foundCal && !choices.some(c => c.id === foundCal.id)) { // Avoid duplicates
      choices.push({ id: foundCal.id!, summary: foundCal.summary! });
    }
  }

  return choices;
}

// --- 4. Create Event Function (with duplicate check) ---

/**
 * Creates an event in Google Calendar, checking for duplicates first.
 * @param event The event object parsed from Gemini.
 * @returns A promise that resolves to the created event data.
 * @throws {DuplicateEventError} If an identical event already exists.
 */
export const createCalendarEvent = async (event: CalendarEvent, calendarId: string): Promise<calendar_v3.Schema$Event> => {
  // Step 1: Check for duplicates
  const existingEvents = await calendar.events.list({
    calendarId: calendarId,
    q: event.title, // Search by title
    timeMin: event.start,
    timeMax: event.end,
    singleEvents: true,
  });

  if (existingEvents.data.items) {
    for (const item of existingEvents.data.items) {
      if (item.summary === event.title) {
        let isDuplicate = false;
        if (event.allDay) {
          // For a single all-day event, we only need to check the start date.
          const eventStartDate = event.start.split('T')[0];
          if (item.start?.date === eventStartDate) {
            isDuplicate = true;
          }
        } else {
          const eventStartTime = new Date(event.start).getTime();
          const eventEndTime = new Date(event.end).getTime();
          const itemStartTime = new Date(item.start!.dateTime!).getTime();
          const itemEndTime = new Date(item.end!.dateTime!).getTime();

          if (itemStartTime === eventStartTime && itemEndTime === eventEndTime) {
            isDuplicate = true;
          }
        }

        if (isDuplicate) {
          console.log('Found duplicate event:', item.htmlLink);
          throw new DuplicateEventError('Event already exists', item.htmlLink);
        }
      }
    }
  }

  // Step 2: If no duplicates, create the new event

  console.log('No duplicates found. Creating new event...');
  const googleEvent: calendar_v3.Schema$Event = {
    summary: event.title,
    start: {
      dateTime: event.allDay ? undefined : event.start,
      date: event.allDay ? event.start.split('T')[0] : undefined,
      timeZone: 'Asia/Taipei',
    },
    end: {
      dateTime: event.allDay ? undefined : event.end,
      date: event.allDay ? event.end.split('T')[0] : undefined,
      timeZone: 'Asia/Taipei',
    },
    recurrence: event.recurrence ? [event.recurrence] : [],
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: event.reminder || 30 },
      ],
    },
  };

  try {
    const response = await calendar.events.insert({
      calendarId: calendarId,
      requestBody: googleEvent,
    });
    console.log('Google Calendar event created:', response.data.htmlLink);
    return response.data;
  } catch (error) {
    console.error('Error creating Google Calendar event:', error);
    throw new Error('Failed to create Google Calendar event.');
  }
};