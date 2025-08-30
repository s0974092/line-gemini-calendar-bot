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

const calendar = google.calendar({ version: 'v3', auth });

// --- 3. Create Event Function (with duplicate check) ---

/**
 * Creates an event in Google Calendar, checking for duplicates first.
 * @param event The event object parsed from Gemini.
 * @returns A promise that resolves to the created event data.
 * @throws {DuplicateEventError} If an identical event already exists.
 */
export const createCalendarEvent = async (event: CalendarEvent): Promise<calendar_v3.Schema$Event> => {
  const calendarId = event.calendarId || 'primary';

  // Step 1: Check for duplicates
  const existingEvents = await calendar.events.list({
    calendarId: calendarId,
    q: event.title, // Search by title
    timeMin: event.start, // Check events starting at the same time
    singleEvents: true,
  });

  if (existingEvents.data.items) {
    for (const item of existingEvents.data.items) {
      // A more robust check for duplicates for both timed and all-day events
      if (item.summary === event.title) {
        let isDuplicate = false;
        if (event.allDay) {
          // For all-day events, compare the 'date' property.
          const eventStartDate = event.start.split('T')[0];
          const eventEndDate = event.end.split('T')[0];
          if (item.start?.date === eventStartDate && item.end?.date === eventEndDate) {
            isDuplicate = true;
          }
        } else {
          // For timed events, compare the 'dateTime' property.
          if (item.start?.dateTime === event.start && item.end?.dateTime === event.end) {
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
