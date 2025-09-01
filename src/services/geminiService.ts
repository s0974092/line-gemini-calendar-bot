import { GoogleGenerativeAI, Part } from '@google/generative-ai';

// Get the API key from environment variables
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

// --- Type Definition for the Calendar Event ---
export interface CalendarEvent {
  title: string;
  start: string; // ISO 8601 format
  end: string;   // ISO 8601 format
  allDay: boolean;
  recurrence: string | null;
  reminder: number; // in minutes
  calendarId: string;
}

// --- Prompt for Initial Text Event Parsing ---
const getEventPrompt = (currentDate: string) => `
You are an expert calendar assistant. Your task is to parse a user's natural language request and convert it into a structured JSON object for creating a Google Calendar event. 

# Rules:
- Today's date is: ${currentDate}. Use this as a reference for relative dates like "tomorrow" or "next Friday".
- The output MUST be a single, valid JSON object. Do not add any extra text, explanations, or markdown formatting around the JSON.
- Default event duration is 1 hour if no end time is specified.
- For recurrence, use the RRULE format. Do NOT add COUNT or UNTIL unless the user explicitly specifies it.
- The timezone is Taipei Standard Time (UTC+8).
- For single-day all-day events (like holidays or birthdays), the 'end' date in the JSON should be the day after the 'start' date. For example, an all-day event for 2025-10-10 would have start: "2025-10-10T00:00:00+08:00" and end: "2025-10-11T00:00:00+08:00".
- **All-Day Event End Dates**: For all-day events, the 'end' date must be exclusive. This means the 'end' date should be set to the morning of the day *after* the event concludes.
  - Example (Single Day): An event on Oct 10th should have an end date of Oct 11th.
  - Example (Multi-Day): An event from Oct 10th to Oct 12th should have an end date of Oct 13th.

# Example:
- User Input: "10/10 國慶日放假"
- Expected JSON: { "title": "國慶日放假", "start": "2025-10-10T00:00:00+08:00", "end": "2025-10-11T00:00:00+08:00", "allDay": true, "recurrence": null, "reminder": 30, "calendarId": "primary" }

# CRITICAL RULE:
  - If the user's input contains both a title (e.g., "會議", "聚餐") and a time, parse both.
  - If the user's input contains a specific time but LACKS a clear event title (e.g., just a time like "明天下午三點"), parse the time but return the "title" field as null.
  - A request with only a title but no time is an incomplete request, return an error: { "error": "Incomplete event information." }.
  - A request with neither a title nor a time is not a calendar event, return an error: { "error": "Not a calendar event." }.

# JSON Format:
{
  "title": "string" | null,
  "start": "YYYY-MM-DDTHH:mm:ss+08:00",
  "end": "YYYY-MM-DDTHH:mm:ss+08:00",
  "allDay": false,
  "recurrence": "RRULE:FREQ=..." | null,
  "reminder": 30,
  "calendarId": "primary"}
`;

// --- Prompt for Shift Schedule (班表) Parsing ---
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

# Time Format
- "1430-22" means 14:30 to 22:00.
- "09-1630" means 09:00 to 16:30.

# Other Rules
- Today's date is: ${currentDate}.
- Timezone is Taipei Standard Time (UTC+8).
- The event title MUST be "${personName} " followed by the time range.
- Ignore summary columns on the far right (e.g., "週工時").

# JSON Event Format
{
  "title": "string",
  "start": "YYYY-MM-DDTHH:mm:ss+08:00",
  "end": "YYYY-MM-DDTHH:mm:ss+08:00",
  "allDay": false,
  "recurrence": null,
  "reminder": 30,
  "calendarId": "primary"
}
`;

// --- Prompt for Parsing Recurrence End Condition ---
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

// --- Prompt for Translating RRULE to Human-Readable Text ---
const getRruleTranslationPrompt = () => `
You are an expert in the iCalendar RRULE format. Your task is to translate a given RRULE string into a human-readable, easy-to-understand description in Traditional Chinese.

# Rules:
- Analyze the RRULE and describe the recurrence pattern clearly and concisely.
- The output MUST be a single, valid JSON object with the key "description".
- Do not add any extra text or explanations.

# JSON Format:
{
  "description": "string"
}
`;

// --- API Call Functions ---

const callGeminiText = async (prompt: string, text: string) => {
  try {
    const model = genAI.getGenerativeModel({
      model: "gemini-1.5-flash",
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
  } catch (error) {
    console.error('Error calling Gemini Text API:', error);
    throw new Error('Failed to call or parse response from Gemini API.');
  }
};

const callGeminiVision = async (prompt: string, imageBase64: string, mimeType: string) => {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
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

  } catch (error) {
    console.error('Error calling Gemini Vision API:', error);
    throw new Error('Failed to call or parse response from Gemini Vision API.');
  }
}

// --- Exported Service Functions ---

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
    // TODO: Detect mimeType from buffer before base64 conversion.
    const mimeType = 'image/jpeg'; // Assuming JPEG for now.
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
    // For this prompt, the rrule is the "text" we want to process
    return await callGeminiText(prompt, rrule);
  } catch (error) {
    return { error: 'Failed to translate RRULE.' };
  }
};
