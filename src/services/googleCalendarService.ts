import { google, calendar_v3 } from 'googleapis';
import { CalendarEvent } from './geminiService';

// --- 1. 自訂重複事件錯誤 ---
export class DuplicateEventError extends Error {
  public htmlLink?: string | null;

  constructor(message: string, htmlLink?: string | null) {
    super(message);
    this.name = 'DuplicateEventError';
    this.htmlLink = htmlLink;
  }
}

// --- 2. 身份驗證 ---
const auth = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET
);
auth.setCredentials({
  refresh_token: process.env.GOOGLE_REFRESH_TOKEN,
});

export const calendar = google.calendar({ version: 'v3', auth });

// --- 3. 日曆列表和選擇邏輯 ---

/**
 * 列出使用者所有的日曆。
 */
export const listAllCalendars = async (): Promise<calendar_v3.Schema$CalendarListEntry[]> => {
  try {
    const response = await calendar.calendarList.list({
      showHidden: true, // 確保我們可以看到所有日曆
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
 * 表示使用者簡化的日曆選擇。
 */
export interface CalendarChoice {
  id: string;
  summary: string;
}

/**
 * 根據 TARGET_CALENDAR_NAME 為使用者產生日曆選擇列表。
 * 始終包含主要日曆，以及最多 2 個額外的匹配日曆。
 * @returns CalendarChoice 物件的陣列。
 */
export async function getCalendarChoicesForUser(): Promise<CalendarChoice[]> {
  const CALENDAR_CHOICE_LIMIT = 3; // 最多 3 個選擇，包括主要日曆
  const targetNamesString = process.env.TARGET_CALENDAR_NAME;
  const targetNames = targetNamesString ? targetNamesString.split(',').map(name => name.trim()).filter(name => name !== '') : [];

  const choices: CalendarChoice[] = [];
  let allUserCalendars: calendar_v3.Schema$CalendarListEntry[] = [];

  try {
    allUserCalendars = await listAllCalendars();
  } catch (error) {
    console.error('Failed to fetch user calendars, defaulting to primary.', error);
    // 如果列出失敗，我們只能提供主要日曆
    choices.push({ id: 'primary', summary: '我的主要日曆' }); // 備用
    return choices;
  }

  // 1. 首先新增主要日曆
  const primaryCalendar = allUserCalendars.find(cal => cal.primary);
  if (primaryCalendar) {
    choices.push({ id: primaryCalendar.id!, summary: primaryCalendar.summary || '我的主要日曆' });
  } else {
    // 理想情況下不應該發生這種情況，但作為備用
    choices.push({ id: 'primary', summary: '我的主要日曆' });
  }

  // 2. 根據優先級和限制新增其他目標日曆
  for (const targetName of targetNames) {
    if (choices.length >= CALENDAR_CHOICE_LIMIT) {
      break; // 達到限制
    }

    const foundCal = allUserCalendars.find(cal => cal.summary === targetName);
    if (foundCal && !choices.some(c => c.id === foundCal.id)) { // 避免重複
      choices.push({ id: foundCal.id!, summary: foundCal.summary! });
    }
  }

  return choices;
}

// --- 4. 建立事件函式 (帶重複檢查) ---

/**
 * 在 Google 日曆中建立事件，首先檢查重複項。
 * @param event 從 Gemini 解析的事件物件。
 * @returns 解析為已建立事件資料的 Promise。
 * @throws {DuplicateEventError} 如果已存在相同事件。
 */
export const createCalendarEvent = async (event: CalendarEvent, calendarId: string): Promise<calendar_v3.Schema$Event> => {
  // 步驟 1: 檢查重複項
  const existingEvents = await calendar.events.list({
    calendarId: calendarId,
    q: event.title, // 按標題搜尋
    timeMin: event.start,
    timeMax: event.end,
    singleEvents: true,
  });

  if (existingEvents.data.items) {
    for (const item of existingEvents.data.items) {
      if (item.summary === event.title) {
        let isDuplicate = false;
        // Case 1: Both are all-day events
        if (event.allDay && item.start?.date) {
          const eventStartDate = event.start.split('T')[0];
          if (item.start.date === eventStartDate) {
            isDuplicate = true;
          }
        } 
        // Case 2: Both are timed events
        else if (!event.allDay && item.start?.dateTime && item.end?.dateTime) {
          const eventStartTime = new Date(event.start).getTime();
          const eventEndTime = new Date(event.end).getTime();
          const itemStartTime = new Date(item.start.dateTime).getTime();
          const itemEndTime = new Date(item.end.dateTime).getTime();

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

  // 步驟 2: 如果沒有重複項，則建立新事件

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

// --- 5. 查詢與修改事件函式 ---

/**
 * 在指定時間範圍內尋找事件。
 * @param timeMin ISO 格式的開始時間字串。
 * @param timeMax ISO 格式的結束時間字串。
 * @param calendarId 要搜尋的日曆 ID。
 * @returns 在該範圍內的事件陣列。
 */
export const findEventsInTimeRange = async (
  timeMin: string,
  timeMax: string,
  calendarId: string
): Promise<calendar_v3.Schema$Event[]> => {
  try {
    const response = await calendar.events.list({
      calendarId: calendarId,
      timeMin: timeMin,
      timeMax: timeMax,
      singleEvents: true, // 將重複事件展開為單一實例
      orderBy: 'startTime',
    });
    return response.data.items || [];
  } catch (error) {
    console.error('Error finding events in time range:', error);
    throw new Error('Failed to find events in the specified time range.');
  }
};

/**
 * 根據時間範圍和可選的關鍵字搜尋事件。
 * 如果未提供 timeMin，則預設從現在開始搜尋。
 * @param calendarId 要搜尋的日曆 ID。
 * @param timeMin 搜尋的開始時間範圍 (ISO 字串)。如果為 null/undefined，則預設為現在。
 * @param timeMax 搜尋的結束時間範圍 (ISO 字串)。
 * @param keyword 可選的關鍵字以供篩選。
 * @returns A promise that resolves to an object containing the found events and a potential nextPageToken.
 */
export const searchEvents = async (
  calendarId: string,
  timeMin: string | null | undefined,
  timeMax: string | null | undefined,
  keyword?: string
): Promise<{ events: calendar_v3.Schema$Event[], nextPageToken?: string | null | undefined }> => {
  try {
    const params: calendar_v3.Params$Resource$Events$List = {
      calendarId: calendarId,
      q: keyword || undefined, // 如果提供則使用關鍵字，否則為 undefined
      maxResults: 10,
      singleEvents: true,
      orderBy: 'startTime',
    };

    // 如果未提供 timeMin，則預設為現在時間，以主要搜尋未來的事件。
    // 這可以防止在一般查詢中傳回不相關的過去事件。
    params.timeMin = timeMin || new Date().toISOString();

    if (timeMax) {
      params.timeMax = timeMax;
    }
    // 如果未提供 timeMax，我們會讓它保持未定義狀態，以搜尋到未來的任何時間。

    const response = await calendar.events.list(params);
    return {
        events: response.data.items || [],
        nextPageToken: response.data.nextPageToken,
    };
  } catch (error) {
    console.error('Error searching for events:', error);
    throw new Error('Failed to search for events.');
  }
};

/**
 * 更新現有的日曆事件 (使用 patch)。
 * @param eventId 要更新的事件 ID。
 * @param calendarId 事件所在的日曆 ID。
 * @param eventPatch 包含要變更欄位的物件。
 * @returns 更新後的事件。
 */
export const updateEvent = async (
  eventId: string,
  calendarId: string,
  eventPatch: calendar_v3.Schema$Event
): Promise<calendar_v3.Schema$Event> => {
  try {
    const response = await calendar.events.patch({
      calendarId: calendarId,
      eventId: eventId,
      requestBody: eventPatch,
    });
    console.log('Google Calendar event updated:', response.data.htmlLink);
    return response.data;
  } catch (error) {
    console.error('Error updating Google Calendar event:', error);
    throw new Error('Failed to update Google Calendar event.');
  }
};

/**
 * Deletes an event from a calendar.
 * @param eventId The ID of the event to delete.
 * @param calendarId The ID of the calendar the event belongs to.
 * @returns A promise that resolves when the event is deleted.
 */
export const deleteEvent = async (
  eventId: string,
  calendarId: string
): Promise<void> => {
  try {
    await calendar.events.delete({
      calendarId: calendarId,
      eventId: eventId,
    });
    console.log(`Event with ID: ${eventId} deleted successfully from calendar: ${calendarId}.`);
  } catch (error) {
    console.error('Error deleting Google Calendar event:', error);
    throw new Error('Failed to delete Google Calendar event.');
  }
};

// --- 6. 取得事件函式 ---

/**
 * 根據 ID 取得單一事件。
 * @param eventId 要取得的事件 ID。
 * @param calendarId 事件所在的日曆 ID。
 * @returns 取得的事件。
 */
export const getEventById = async (
  eventId: string,
  calendarId: string
): Promise<calendar_v3.Schema$Event> => {
  try {
    const response = await calendar.events.get({
      calendarId: calendarId,
      eventId: eventId,
    });
    return response.data;
  } catch (error) {
    console.error('Error getting event by ID:', error);
    throw new Error('Failed to get event by ID.');
  }
};
