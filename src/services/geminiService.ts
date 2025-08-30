import { GoogleGenerativeAI } from '@google/generative-ai';

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

// --- Prompt for Initial Event Parsing ---
const getEventPrompt = (currentDate: string) => `
You are an expert calendar assistant. Your task is to parse a user's natural language request and convert it into a structured JSON object for creating a Google Calendar event. 

# Rules:
- Today's date is: ${currentDate}. Use this as a reference for relative dates like "tomorrow" or "next Friday".
- The output MUST be a single, valid JSON object. Do not add any extra text, explanations, or markdown formatting around the JSON.
- Default event duration is 1 hour if no end time is specified.
- For recurrence, use the RRULE format. Do NOT add COUNT or UNTIL unless the user explicitly specifies it.
- The timezone is Taipei Standard Time (UTC+8).

- **CRITICAL RULE**: 
  - If the user's input contains a specific time but LACKS a clear event title (e.g., "會議", "聚餐"), parse the time but return the "title" field as null.
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

# Examples:
1. Input: "明天晚上 7 點家庭聚餐"
   Output: {"title":"家庭聚餐","start":"2025-08-30T19:00:00+08:00","end":"2025-08-30T20:00:00+08:00","allDay":false,"recurrence":null,"reminder":30,"calendarId":"primary"}

2. Input: "每週二早上 9 點晨會"
   Output: {"title":"晨會","start":"2025-09-02T09:00:00+08:00","end":"2025-09-02T10:00:00+08:00","allDay":false,"recurrence":"RRULE:FREQ=WEEKLY;BYDAY=TU","reminder":30,"calendarId":"primary"}

3. Input: "明天下午三點"
   Output: {"title":null,"start":"2025-08-30T15:00:00+08:00","end":"2025-08-30T16:00:00+08:00","allDay":false,"recurrence":null,"reminder":30,"calendarId":"primary"}

4. Input: "有個會議"
   Output: {"error": "Incomplete event information."}
`;

// --- Prompt for Parsing Recurrence End Condition ---
const getRecurrenceEndPrompt = (baseRrule: string, startDate: string, currentDate: string) => `
You are an expert in iCalendar RRULE format. Your task is to take a user's natural language description of an end condition and append it to an existing RRULE string.

# Context:
- Base RRULE: ${baseRrule}
- Event Start Date: ${startDate}
- Today's Date: ${currentDate}

# Rules:
- Analyze the user's request and convert it into either a 
COUNT=N
 or 
UNTIL=YYYYMMDDTHHMMSSZ
 part.
- If the user's response indicates that the event should repeat indefinitely (e.g., "永久重複", "不用設定", "一直持續"), you MUST return the original 
baseRrule
 without any changes.
- Append the generated part to the base RRULE. If there is no change, the updatedRrule will be the same as the baseRrule.
- For 
UNTIL
, the format must be 
YYYYMMDDTHHMMSSZ
. Use the provided Start Date and Current Date for context.
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

// --- Main API Call Function ---
const callGemini = async (prompt: string, text: string) => {
  try {
    const model = genAI.getGenerativeModel({ model: "gemini-1.5-flash" });
    const fullPrompt = `${prompt}\n\n# User Input:\n"${text}"`;
    const result = await model.generateContent(fullPrompt);
    const response = await result.response;
    const responseText = response.text().replace(/```json|```/g, '').trim();
    console.log('Gemini Raw Response:', responseText);
    return JSON.parse(responseText);
  } catch (error) {
    console.error('Error calling Gemini API:', error);
    throw new Error('Failed to call or parse response from Gemini API.');
  }
};

// --- Exported Service Functions ---

export const parseTextToCalendarEvent = async (text: string): Promise<Partial<CalendarEvent> | { error: string }> => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const prompt = getEventPrompt(today);
    return await callGemini(prompt, text);
  } catch (error) {
    return { error: 'Failed to parse event from text.' };
  }
};

export const parseRecurrenceEndCondition = async (text: string, baseRrule: string, startDate: string): Promise<{ updatedRrule: string } | { error: string }> => {
  try {
    const today = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Taipei' });
    const prompt = getRecurrenceEndPrompt(baseRrule, startDate, today);
    return await callGemini(prompt, text);
  } catch (error) {
    return { error: 'Failed to parse recurrence end condition.' };
  }
};

export const translateRruleToHumanReadable = async (rrule: string): Promise<{ description: string } | { error: string }> => {
  try {
    const prompt = getRruleTranslationPrompt();
    // For this prompt, the rrule is the "text" we want to process
    return await callGemini(prompt, rrule);
  } catch (error) {
    return { error: 'Failed to translate RRULE.' };
  }
};
