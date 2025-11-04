import { GoogleGenerativeAI, Part } from '@google/generative-ai';

// 從環境變數中獲取 API 金鑰和模型名稱
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');
const DEFAULT_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

// --- 日曆事件的類型定義 ---
export interface CalendarEvent {
  title: string;
  start: string; // ISO 8601 格式
  end: string;   // ISO 8601 格式
  allDay: boolean;
  recurrence: string | string[] | null;
  reminder?: number; // 以分鐘為單位
  calendarId: string;
  location?: string; // 可選的地點
  description?: string; // 可選的描述
}

// --- 初始文字事件解析的提示 ---
const getEventPrompt = (currentDate: string) => `
You are an expert calendar assistant. Your task is to parse a user's natural language request and convert it into a structured JSON object for creating a Google Calendar event. 

# Rules:
- Today's date is: ${currentDate}. Use this as a reference for relative dates like "tomorrow" or "next Friday".
- The output MUST be a single, valid JSON object. Do not add any extra text, explanations, or markdown formatting around the JSON.
- Default event duration is 1 hour if no end time is specified.
- The timezone is Taipei Standard Time (UTC+8).

# All-Day Events:
- If the user mentions "全天" (all-day) or "整天" (whole day), you MUST set "allDay" to true.
- For all-day events, "start" and "end" fields MUST be in "YYYY-MM-DD" format.
- For a single all-day event, the "end" date must be the day AFTER the "start" date. For example, an all-day event on "2025-11-25" has start: "2025-11-25" and end: "2025-11-26".

# Other Fields:
- For recurrence, use the RRULE format. Do NOT add COUNT or UNTIL unless the user explicitly specifies it.
- Also parse any location (e.g., "at 3rd floor meeting room A") or description/notes (e.g., "bring your laptop"). If not present, these fields should be null.

# Examples:
- User Input: "明天下午三點在會議室B跟客戶開會，討論新的設計稿"
  - Expected JSON: { "title": "跟客戶開會", "start": "2025-09-09T15:00:00+08:00", "end": "2025-09-09T16:00:00+08:00", "allDay": false, "recurrence": null, "calendarId": "primary", "location": "會議室B", "description": "討論新的設計稿" }
- User Input: "11/25 全天 參加研討會"
  - Expected JSON: { "title": "參加研討會", "start": "2025-11-25", "end": "2025-11-26", "allDay": true, "recurrence": null, "calendarId": "primary", "location": null, "description": null }
- User Input: "從11/1到11/11每天早上十點檢查EMAIL"
  - Expected JSON: { "title": "檢查EMAIL", "start": "2025-11-01T10:00:00+08:00", "end": "2025-11-01T11:00:00+08:00", "allDay": false, "recurrence": "RRULE:FREQ=DAILY;UNTIL=20251111T100000Z", "calendarId": "primary", "location": null, "description": null }

# CRITICAL RULE:
  - If the user's input contains both a title (e.g., "會議", "聚餐") and a time, parse both.
  - If the user's input contains a specific time but LACKS a clear event title (e.g., just a time like "明天下午三點"), parse the time but return the "title" field as null.
  - A request with only a title but no time is an incomplete request, return an error: { "error": "Incomplete event information." }.
  - A request with neither a title nor a time is not a calendar event, return an error: { "error": "Not a calendar event." }.

# JSON Format:
{
  "title": "string" | null,
  "start": "YYYY-MM-DDTHH:mm:ss+08:00" | "YYYY-MM-DD",
  "end": "YYYY-MM-DDTHH:mm:ss+08:00" | "YYYY-MM-DD",
  "allDay": boolean,
  "recurrence": "RRULE:FREQ=..." | null,
  "calendarId": "primary",
  "location": "string" | null,
  "description": "string" | null
}
`;

// --- 班表解析的提示 ---
const getShiftSchedulePrompt = (currentDate: string, personName: string) => `
You are an expert assistant for parsing a shift schedule image for an employee named "${personName}".

# Core Logic
1.  **Find the Row:** First, locate the row that starts with the name "${personName}" on the far left. This single row contains all shifts for this person across the entire image.
2.  **Scan Horizontally:** Follow this row from left to right across the entire page, through all tables.
3.  **Identify Dates:** The dates for the shifts are in the header rows of the tables. A date is defined by a "星期" (day of week) row and a "日期" (date of month) row below it.
4.  **Extract Shifts:** For each date column, the shift is at the intersection of that date's column and the "${personName}" row.
5.  **IGNORE ALL TEXT:** The employee "${personName}" ONLY has shifts written as time ranges (e.g., "1430-22", "09-1630"). You MUST completely ignore any text-based shifts like "早班" or "晚班" anywhere on the sheet, as they are irrelevant for this person and are the main source of errors.
6.  **Skip Blank Days:** If the intersection cell is blank or contains "休" or "假", it is a day off and must be skipped.
7.  **Format the Output:** Create a JSON object containing an "events" array for all valid shifts found.

# Time Format:
- "1430-22" means 14:30 to 22:00.
- "09-1630" means 09:00 to 16:30.

# Other Rules:
- Today's date is: ${currentDate}.
- Timezone is Taipei Standard Time (UTC+8).
- The event title MUST be "${personName} " followed by the time range.
- Ignore summary columns on the far right (e.g., "週工時").

# JSON Event Format:
{
  "title": "string",
  "start": "YYYY-MM-DDTHH:mm:ss+08:00",
  "end": "YYYY-MM-DDTHH:mm:ss+08:00",
  "allDay": false,
  "recurrence": null,

  "calendarId": "primary"
}
`;

// --- 解析重複結束條件的提示 ---
const getRecurrenceEndPrompt = (baseRrule: string, startDate: string, currentDate: string) => `
You are an expert in iCalendar RRULE format. Your task is to take a user's natural language description of an end condition and append it to an existing RRULE string.

# Context:
- Base RRULE: ${baseRrule}
- Event Start Date: ${startDate}
- Today's Date: ${currentDate}

# Rules:
- Analyze the user's request and convert it into either a COUNT=N or UNTIL=YYYYMMDDTHHMMSSZ part.
- If the user's response indicates that the event should repeat indefinitely (e.g., "永久重複", "不用設定", "一直持續"), you MUST return the original baseRrule without any changes.
- Append the generated part to the base RRULE. If there is no change, the updatedRrule will be the same as the baseRrule.
- For UNTIL, the format must be YYYYMMDDTHHMMSSZ. Use the provided Start Date and Current Date for context.
- The output MUST be a single, valid JSON object with the key "updatedRrule".
- If the user's request is unclear, return an error: {"error": "Cannot parse end condition."}

# JSON Format:
{"updatedRrule": "RRULE:..."}
`;

// --- 將 RRULE 翻譯為人類可讀文字的提示 ---
const getRruleTranslationPrompt = () => `
You are an expert in the iCalendar RRULE format. Your task is to translate a given RRULE string into a human-readable, easy-to-understand description of its frequency in Traditional Chinese.

# Rules:
- Analyze the RRULE and describe ONLY the frequency pattern (e.g., "每日", "每週", "每月").
- **CRITICAL**: Do NOT include any information about the end condition (like UNTIL or COUNT) in the description. For example, for "FREQ=DAILY;UNTIL=...", just return "每日".
- The output MUST be a single, valid JSON object with the key "description".
- Do not add any extra text or explanations.

# Examples:
- Input: "RRULE:FREQ=DAILY;UNTIL=20251231T000000Z" -> Output: { "description": "每日" }
- Input: "RRULE:FREQ=WEEKLY;BYDAY=MO,FR" -> Output: { "description": "每週的星期一和星期五" }
- Input: "RRULE:FREQ=MONTHLY;COUNT=5" -> Output: { "description": "每月" }

# JSON Format:
{
  "description": "string"
}
`;

const getRecurrenceEndDatePrompt = (rrule: string, startDate: string) => `
You are an expert in the iCalendar RRULE format. Your task is to calculate the end date of a recurring event based on its start date and RRULE.

# Context:
- Start Date: ${startDate}
- RRULE: ${rrule}

# Rules:
- Analyze the RRULE and the start date to determine the final date of the last occurrence.
- The output MUST be a single, valid JSON object with the key "endDate", in "YYYY-MM-DD" format.
- The timezone for calculations should be Taipei Standard Time (UTC+8).
- If the RRULE does not have a COUNT or UNTIL (i.e., it's infinite), return null for the endDate.

# Examples:
- Start Date: "2025-11-12T10:00:00+08:00", RRULE: "RRULE:FREQ=DAILY;COUNT=3" -> Output: { "endDate": "2025-11-14" }
- Start Date: "2025-11-10T09:00:00+08:00", RRULE: "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4" -> Output: { "endDate": "2025-11-19" }
- Start Date: "2025-01-01T10:00:00+08:00", RRULE: "RRULE:FREQ=MONTHLY;COUNT=6" -> Output: { "endDate": "2025-06-01" }

# JSON Format:
{
  "endDate": "YYYY-MM-DD" | null
}
`;

// --- 新增：解析事件更新的提示 ---
const getUpdateChangesPrompt = (currentDate: string) => `
You are an expert calendar assistant. Your task is to parse a user's natural language description of a change to an event and convert it into a structured JSON object.

# Rules:
- Today's date is: ${currentDate}. Use this as a reference for relative dates.
- The user is already in the process of updating an event, so their input will be concise.
- The output MUST be a single, valid JSON object. Do not add any extra text or explanations.
- If the user specifies a new time, provide both "start" and "end" times. Default duration is 1 hour if no end time is specified.
- The timezone is Taipei Standard Time (UTC+8).
- If the user's request is unclear or doesn't seem to describe a change, return an error: {"error": "Cannot parse changes."}

# JSON Format for Changes:
{
  "title": "string" | null,
  "start": "YYYY-MM-DDTHH:mm:ss+08:00" | null,
  "end": "YYYY-MM-DDTHH:mm:ss+08:00" | null,
  "location": "string" | null,
  "description": "string" | null
}

# Examples (Today is 2025-09-08):
- User Input: "時間改到明天下午兩點" -> {"start": "2025-09-09T14:00:00+08:00", "end": "2025-09-09T15:00:00+08:00"}
- User Input: "標題改成團隊午餐" -> {"title": "團隊午餐"}
- User Input: "地點改到公司會議室" -> {"location": "公司會議室"}
- User Input: "備註改成記得帶筆電" -> {"description": "記得帶筆電"}
- User Input: "改成明天下午三點的團隊午餐，地點在公司" -> {"title": "團隊午餐", "start": "2025-09-09T15:00:00+08:00", "end": "2025-09-09T16:00:00+08:00", "location": "公司"}
`;

// --- API 呼叫函式 ---

const callGeminiText = async (prompt: string, text: string) => {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;
  let lastError: any;

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const model = genAI.getGenerativeModel({
        model: DEFAULT_MODEL,
        generationConfig: {
          temperature: 0,
          responseMimeType: "application/json",
        }
      });
      const fullPrompt = `${prompt}\n\n# User Input:\n\"${text}\"`;
      const result = await model.generateContent(fullPrompt);
      const response = await result.response;
      const responseText = response.text();
      console.log('Gemini Raw Text Response:', responseText);
      return JSON.parse(responseText);
    } catch (error: any) {
      lastError = error;
      if (error && typeof error === 'object' && 'status' in error && error.status === 503 && i < MAX_RETRIES - 1) {
        console.warn(`Gemini API returned 503, retrying in ${RETRY_DELAY_MS}ms... (Attempt ${i + 1}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      break; // Exit loop for non-retryable errors or last attempt
    }
  }
  console.error('Error calling Gemini Text API:', lastError);
  throw new Error('Failed to call or parse response from Gemini API.');
};

const callGeminiVision = async (prompt: string, imageBase64: string, mimeType: string) => {
  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 2000;
  let lastError: any;

  for (let i = 0; i < MAX_RETRIES; i++) {
    try {
      const model = genAI.getGenerativeModel({ model: DEFAULT_MODEL });
      const imagePart: Part = {
        inlineData: {
          data: imageBase64,
          mimeType
        }
      };
      const textPart: Part = {
        text: prompt
      };

      const result = await model.generateContent([textPart, imagePart]);
      const response = await result.response;
      const responseText = response.text().replace(/```json|```/g, '').trim();
      console.log('Gemini Raw Vision Response:', responseText);
      return JSON.parse(responseText);
    } catch (error: any) {
      lastError = error;
      if (error && typeof error === 'object' && 'status' in error && error.status === 503 && i < MAX_RETRIES - 1) {
        console.warn(`Gemini Vision API returned 503, retrying in ${RETRY_DELAY_MS}ms... (Attempt ${i + 1}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, RETRY_DELAY_MS));
        continue;
      }
      break; // Exit loop for non-retryable errors or last attempt
    }
  }
  console.error('Error calling Gemini Vision API:', lastError);
  throw new Error('Failed to call or parse response from Gemini Vision API.');
}

// --- 匯出的服務函式 ---

export const parseTextToCalendarEvent = async (text: string): Promise<Partial<CalendarEvent> | { error: string }> => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const prompt = getEventPrompt(today);
    return await callGeminiText(prompt, text);
  } catch (error) {
    return { error: 'Failed to parse event from text.' };
  }
};

export const parseImageToCalendarEvents = async (imageBase64: string, personName: string): Promise<{ events: CalendarEvent[] } | { error: string }> => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const prompt = getShiftSchedulePrompt(today, personName);
    // TODO: 在 base64 轉換前從緩衝區檢測 mimeType。
    const mimeType = 'image/jpeg'; // 目前假設為 JPEG。
    return await callGeminiVision(prompt, imageBase64, mimeType);
  } catch (error) {
    return { error: 'Failed to parse event from image.' };
  }
};

export const parseRecurrenceEndCondition = async (text: string, baseRrule: string, startDate: string): Promise<{ updatedRrule: string } | { error: string }> => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const prompt = getRecurrenceEndPrompt(baseRrule, startDate, today);
    return await callGeminiText(prompt, text);
  } catch (error) {
    return { error: 'Failed to parse recurrence end condition.' };
  }
};

export const translateRruleToHumanReadable = async (rrule: string): Promise<{ description: string } | { error: string }> => {
  try {
    const prompt = getRruleTranslationPrompt();
    // 對於此提示，rrule 是我們要處理的「文字」
    return await callGeminiText(prompt, rrule);
  } catch (error) {
    return { error: 'Failed to translate RRULE.' };
  }
};

export const parseEventChanges = async (text: string): Promise<Partial<CalendarEvent> | { error: string }> => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const prompt = getUpdateChangesPrompt(today);
    return await callGeminiText(prompt, text);
  } catch (error) {
    return { error: 'Failed to parse event changes from text.' };
  }
};

export const getRecurrenceEndDate = async (rrule: string, startDate: string): Promise<{ endDate: string | null } | { error: string }> => {
  try {
    const prompt = getRecurrenceEndDatePrompt(rrule, startDate);
    // For this prompt, the input text to the model is empty as the context is in the prompt itself.
    return await callGeminiText(prompt, '');
  } catch (error) {
    return { error: 'Failed to calculate recurrence end date.' };
  }
}; 

// --- 新增：意圖分類函式 ---
export type Intent = 
  | { type: 'create_event'; event: Partial<CalendarEvent> }
  | { type: 'query_event'; timeMin: string; timeMax: string; query: string; }
  | { type: 'update_event'; timeMin: string; timeMax: string; query: string; changes: Partial<Omit<CalendarEvent, 'calendarId' | 'recurrence'>> }
  | { type: 'delete_event'; timeMin: string; timeMax: string; query: string; }
  | { type: 'create_schedule'; personName: string }
  | { type: 'incomplete'; originalText: string }
  | { type: 'unknown'; originalText: string };


const getIntentPrompt = (currentDate: string) => `
You are an expert in understanding user requests for a calendar bot. Your primary goal is to classify the user's intent and extract relevant information into a structured JSON object.

# Today's Date: ${currentDate}

# Intents:
1.  **create_event**: User wants to add a new event.
    - Extracts: A full or partial event object, including title, start, end, location, and description.
    - **All-Day Rule**: If the user mentions a date but no specific time, and the context implies a holiday or day off (e.g., "放假", "補假", "國慶日", or other public holidays), it MUST be treated as an all-day event. For all-day events, 'start' should be the date and 'end' should be the following date (e.g., start: "2025-10-10", end: "2025-10-11").
2.  **query_event**: User wants to find an existing event.
    - Extracts: A time range (timeMin, timeMax) and a text search keyword (query).
    - **CRITICAL**: The 'query' should be the most likely title of an *existing* event. Strip away conversational filler like "活動", "的活動", "的事", "行程", "幫我找一下", "查一下", "有什麼".
    - **CRITICAL**: If the user is asking a general question about what events exist (e.g., "有什麼事", "有什麼活動"), the 'query' field should be an empty string.
3.  **update_event**: User wants to change an existing event.
    - Extracts: A query to find the original event and a 'changes' object containing the fields to be updated (e.g., title, start, end, location, description).
4.  **delete_event**: User wants to remove an event.
    - Extracts: A time range (timeMin, timeMax) and a text search keyword (query), similar to query_event.
5.  **create_schedule**: User wants to create a work schedule from a file.
    - Extracts: The person's name.
6.  **incomplete**: The request is for creating an event but is missing crucial details.
7.  **unknown**: The request is not related to any of the above intents.

# JSON Output Structure:
- For "create_event": { "type": "create_event", "event": { ... } }
- For "query_event": { "type": "query_event", "timeMin": "...", "timeMax": "...", "query": "..." }
- For "update_event": { "type": "update_event", "timeMin": "...", "timeMax": "...", "query": "...", "changes": { "title": "...", "start": "...", "location": "...", "description": "..." } }
- For "delete_event": { "type": "delete_event", "timeMin": "...", "timeMax": "...", "query": "..." }
- For "create_schedule": { "type": "create_schedule", "personName": "..." }
- For "incomplete" or "unknown": { "type": "...", "originalText": "..." }

# Example (Today is 2025-09-08):
- User: "10月10號國慶日放假" -> { "type": "create_event", "event": { "title": "國慶日放假", "start": "2025-10-10", "end": "2025-10-11", "allDay": true } }
- User: "把明天下午3點的會議地點改到線上會議室" -> { "type": "update_event", "timeMin": "2025-09-09T15:00:00+08:00", "timeMax": "2025-09-09T16:00:00+08:00", "query": "會議", "changes": { "location": "線上會議室" } }
- User: "幫我查一下明天下午的會議" -> { "type": "query_event", "timeMin": "2025-09-09T12:00:00+08:00", "timeMax": "2025-09-09T17:00:00+08:00", "query": "會議" }
- User: "取消明天下午的會議" -> { "type": "delete_event", "timeMin": "2025-09-09T12:00:00+08:00", "timeMax": "2025-09-09T17:00:00+08:00", "query": "會議" }
- User: "明天下午三點跟客戶開會，地點在客戶公司，要記得帶合約" -> { "type": "create_event", "event": { "title": "跟客戶開會", "start": "2025-09-09T15:00:00+08:00", "end": "2025-09-09T16:00:00+08:00", "location": "客戶公司", "description": "要記得帶合約" } }
- User: "每週一早上9點的站立會議" -> { "type": "create_event", "event": { "title": "站立會議", "start": "2025-09-15T09:00:00+08:00", "end": "2025-09-15T10:00:00+08:00", "recurrence": "RRULE:FREQ=WEEKLY;BYDAY=MO" } }
- User: "明天早上十點" -> { "type": "create_event", "event": { "title": null, "start": "2025-09-09T10:00:00+08:00", "end": "2025-09-09T11:00:00+08:00", "location": null, "description": null } }
`;

export const classifyIntent = async (text: string): Promise<Intent> => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const prompt = getIntentPrompt(today);
    const result = await callGeminiText(prompt, text);

    if (result && result.type === 'create_event' && result.event) {
      const event = result.event as Partial<CalendarEvent>;
      
      if (text.includes('全天') || text.includes('整天')) {
        console.log('All-day keyword detected. Forcing event to all-day format.');

        // Regardless of what Gemini returned, if it has a time component,
        // extract the date part. The start date is the most reliable anchor.
        if (event.start) {
            const startDateString = event.start.substring(0, 10); // "YYYY-MM-DD"
            
            // Create the end date by adding one day to the start date.
            const startDate = new Date(startDateString);
            startDate.setDate(startDate.getDate() + 1);
            const endDateString = startDate.toISOString().split('T')[0];

            // Force the event object into the correct format.
            event.allDay = true;
            event.start = startDateString;
            event.end = endDateString;
        }
      }
    }

    if (result && result.type) {
      return result as Intent;
    }
    console.warn('Gemini intent classification result is missing "type" property:', result);
    return { type: 'unknown', originalText: text };
  } catch (error) {
    console.error('Error in classifyIntent:', error);
    return { type: 'unknown', originalText: text };
  }
};