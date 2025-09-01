import 'dotenv/config';
import express, { Request, Response } from 'express';
import {
  Client,
  middleware,
  WebhookEvent,
  MiddlewareConfig,
  ClientConfig,
  TemplateMessage,
  PostbackEvent,
  TextEventMessage,
  ImageEventMessage,
  Message,
  FileEventMessage,
  TextMessage,
} from '@line/bot-sdk';
import { calendar_v3 } from 'googleapis';
import {
  parseTextToCalendarEvent,
  CalendarEvent,
  parseRecurrenceEndCondition,
  translateRruleToHumanReadable,
  parseImageToCalendarEvents,
} from './services/geminiService';
import { calendar, createCalendarEvent, DuplicateEventError, getCalendarChoicesForUser, CalendarChoice } from './services/googleCalendarService';
import { Stream } from 'stream';
import * as fs from 'fs/promises';
import * as path from 'path';

// --- 1. Configuration ---
if (!process.env.LINE_CHANNEL_SECRET || !process.env.LINE_CHANNEL_ACCESS_TOKEN) {
  throw new Error('Missing LINE channel secret or access token');
}
const lineConfig: MiddlewareConfig = { channelSecret: process.env.LINE_CHANNEL_SECRET };
const clientConfig: ClientConfig = { channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN };
const lineClient = new Client(clientConfig);
const userWhitelist: string[] = (process.env.USER_WHITELIST || '').split(',');

// --- 2. In-Memory State & Payloads ---

// For multi-turn conversations
interface ConversationState {
  step: 'awaiting_recurrence_end_condition' | 'awaiting_event_title' | 'awaiting_bulk_confirmation' | 'awaiting_csv_upload' | 'awaiting_calendar_choice';
  event?: Partial<CalendarEvent>; // For single event creation
  events?: CalendarEvent[]; // For bulk event creation
  personName?: string; // For schedule image analysis
  timestamp: number; // To handle timeouts
}
const conversationStates = new Map<string, ConversationState>();

// --- 3. Express App Setup ---
const app = express();
app.get('/', (req: Request, res: Response) => res.send('LINE Gemini Calendar Bot is running!'));
app.post('/api/webhook', middleware(lineConfig), async (req: Request, res: Response) => {
  try {
    const events: WebhookEvent[] = req.body.events;
    const results = await Promise.all(events.map(handleEvent));
    res.status(200).json(results);
  } catch (err: unknown) {
    console.error("!!!!!!!!!! TOP LEVEL ERROR START !!!!!!!!!!");
    console.error(JSON.stringify(err, null, 2));
    console.error("!!!!!!!!!! TOP LEVEL ERROR END !!!!!!!!!!");
    res.status(500).send('Error processing webhook');
  }
});

// --- 4. Main Event Router ---
const handleEvent = async (event: WebhookEvent) => {
  const userId = event.source.userId;
  if (!userId || !userWhitelist.includes(userId)) {
    console.log(`Rejected event from non-whitelisted user: ${userId}`);
    return null;
  }

  // Generic timeout check for any state
  const currentState = conversationStates.get(userId);
  if (currentState && (Date.now() - currentState.timestamp > 10 * 60 * 1000)) { // 10 minute timeout
    console.log(`State for user ${userId} has expired.`);
    conversationStates.delete(userId);
  }

  switch (event.type) {
    case 'message':
      if (event.message.type === 'file') {
        return handleFileMessage(event.replyToken, event.message as FileEventMessage, userId);
      } else if (event.message.type === 'image') {
        return handleImageMessage(event.replyToken, event.message, userId);
      } else if (event.message.type === 'text') {
        return handleTextMessage(event.replyToken, event.message, userId);
      }
      break;
    case 'postback':
      return handlePostbackEvent(event);
    default:
      console.log(`Unhandled event type: ${event.type}`);
      return null;
  }
};

// --- 5. Message Handlers ---

// --- 5a. Image Message Handler (New Flow) ---
// NOTE: This flow is temporarily disabled in favor of CSV-based scheduling.
const handleImageMessage = async (replyToken: string, message: ImageEventMessage, userId: string) => {
  return lineClient.replyMessage(replyToken, { type: 'text', text: '圖片班表功能已暫停，請改用「幫 [姓名] 建立班表」指令來上傳 CSV 檔案。' });
};

// Helper to convert stream to string
const streamToString = (stream: Stream): Promise<string> => {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
};

const handleFileMessage = async (replyToken: string, message: FileEventMessage, userId: string) => {
  const currentState = conversationStates.get(userId);

  // Check if we are waiting for a CSV upload
  if (!currentState || currentState.step !== 'awaiting_csv_upload' || !currentState.personName) {
    return lineClient.replyMessage(replyToken, { type: 'text', text: '感謝您傳送檔案，但我不知道該如何處理它。如果您想建立班表，請先傳送「幫 [姓名] 建立班表」。' });
  }

  if (!message.fileName.toLowerCase().endsWith('.csv')) {
    return lineClient.replyMessage(replyToken, { type: 'text', text: '檔案格式錯誤，請上傳 .csv 格式的班表檔案。' });
  }

  const personName = currentState.personName;
  console.log(`CSV file received for schedule analysis for person: "${personName}"`);
  
  try {
    const fileContentStream = await lineClient.getMessageContent(message.id);
    const csvContent = await streamToString(fileContentStream);
    const events = parseCsvToEvents(csvContent, personName);

    conversationStates.delete(userId); // Clear state after processing

    if (events.length === 0) {
      return lineClient.replyMessage(replyToken, { type: 'text', text: `在您上傳的 CSV 檔案中，找不到「${personName}」的任何班次，或格式不正確。` });
    }

    // Step 1: Log the parsed events for user confirmation
    const eventListText = events.map(event => {
      const startDate = new Date(event.start);
      const endDate = new Date(event.end);
      const date = startDate.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Taipei' });
      const startTime = startDate.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });
      const endTime = endDate.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });
      return `✅ ${date} ${startTime}-${endTime} ${event.title.replace(personName, '').trim()}`;
    }).join('\n');

    const summaryMessage: TextMessage = {
      type: 'text',
      text: `已為「${personName}」解析出以下 ${events.length} 個班次，請確認：\n\n${eventListText}`
    };

    // Step 2: Set new state for confirmation
    conversationStates.set(userId, { step: 'awaiting_bulk_confirmation', events, timestamp: Date.now() });

    // Step 3: Send the confirmation button
    const summaryText = `您要將這 ${events.length} 個活動一次全部新增至您的 Google 日曆嗎？`;

    const confirmationTemplate: TemplateMessage = {
      type: 'template',
      altText: '需要您確認批次新增活動',
      template: {
        type: 'buttons',
        title: `為 ${personName} 批次新增活動 (CSV)`,
        text: summaryText,
        actions: [
          { type: 'postback', label: '全部新增', data: 'action=createAllShifts' },
          { type: 'postback', label: '取消', data: 'action=cancel' },
        ],
      },
    };
    return lineClient.replyMessage(replyToken, [summaryMessage, confirmationTemplate]);

  } catch (error) {
    console.error('Error processing uploaded CSV file:', error);
    conversationStates.delete(userId); // Clear state on error
    return lineClient.replyMessage(replyToken, { type: 'text', text: '處理您上傳的 CSV 檔案時發生錯誤。' });
  }
};

export const parseCsvToEvents = (csvContent: string, personName: string): CalendarEvent[] => {
  // Remove BOM character if present
  if (csvContent.charCodeAt(0) === 0xFEFF) {
    csvContent = csvContent.slice(1);
  }

  let lines = csvContent.trim().split(/\r?\n/); // Handles both \n and \r\n
  // Find the actual header row, assuming it starts with "姓名"
  const headerRowIndex = lines.findIndex(line => line.startsWith('"姓名"') || line.startsWith('姓名'));
  
  if (headerRowIndex === -1) {
    console.log('CSV PARSE DEBUG: Header row starting with "姓名" not found.');
    return [];
  }

  // Discard any lines before the header row
  lines = lines.slice(headerRowIndex);

  const events: CalendarEvent[] = [];
  if (lines.length < 2) return []; // Not enough data

  const header = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  const dateHeaders = header.slice(2);

  const normalizedPersonName = personName.normalize('NFC');

  const personRow = lines.slice(1).find(line => {
    const firstCell = line.split(',')[0];
    if (!firstCell) return false;
    // Normalize, remove quotes, and trim to ensure robust comparison
    const cleanedName = firstCell.replace(/"/g, '').trim().normalize('NFC');
    return cleanedName === normalizedPersonName;
  });

  if (!personRow) {
    console.log(`CSV PARSE DEBUG: Could not find row for personName: "${personName}"`);
    const foundNames = lines.slice(1).map(line => {
      const cell = line.split(',')[0];
      return cell ? cell.replace(/"/g, '').trim().normalize('NFC') : '';
    });
    console.log(`CSV PARSE DEBUG: Found names:`, foundNames);
    return [];
  }

  const rowData = personRow.split(',').map(d => d.replace(/"/g, '').trim());
  const shiftData = rowData.slice(2);

  const year = new Date().getFullYear(); // Assuming current year

  dateHeaders.forEach((dateStr, index) => {
    const shift = shiftData[index];
    if (!shift || shift === '假' || shift === '休') return;

    const [month, day] = dateStr.split('/').map(Number);

    let startHour: string, startMinute: string, endHour: string, endMinute: string;

    // Map descriptive shifts to time ranges
    switch (shift) {
      case '早班':
        startHour = '09'; startMinute = '00'; endHour = '17'; endMinute = '00';
        break;
      case '晚班':
        startHour = '14'; startMinute = '00'; endHour = '22'; endMinute = '00';
        break;
      case '早接菜':
        startHour = '07'; startMinute = '00'; endHour = '15'; endMinute = '00';
        break;
      // Add more cases for other descriptive shifts as needed
      default:
        // If it's not a descriptive shift, try to match the time pattern
        const timeMatch = shift.match(/(\d{1,2})(\d{2})?-(\d{1,2})(\d{2})?/);
        if (!timeMatch) return; // If no match, skip this shift

        startHour = timeMatch[1].padStart(2, '0');
        startMinute = timeMatch[2] || '00';
        endHour = timeMatch[3].padStart(2, '0');
        endMinute = timeMatch[4] || '00';
        break;
    }

    const startDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    events.push({
      title: `${personName} ${shift}`,
      start: `${startDate}T${startHour}:${startMinute}:00+08:00`,
      end: `${startDate}T${endHour}:${endMinute}:00+08:00`,
      allDay: false,
      recurrence: null,
      reminder: 30,
      calendarId: 'primary',
    });
  });

  return events;
};

// --- 5b. Text Message Handler (New Flow) ---
const handleTextMessage = async (replyToken: string, message: TextEventMessage, userId: string) => {
  const currentState = conversationStates.get(userId);

  // --- New Schedule Analysis Trigger ---
  const nameMatch = message.text.match(/幫(?:「|『)?(.+?)(?:」|『)?建立班表/);
  if (nameMatch) {
    const personName = nameMatch[1].trim();
    console.log(`Request to create schedule for "${personName}". Awaiting CSV file.`);
    conversationStates.set(userId, {
      step: 'awaiting_csv_upload',
      personName: personName, 
      timestamp: Date.now() 
    });
    return lineClient.replyMessage(replyToken, {
      type: 'text', 
      text: `好的，請現在傳送您要為「${personName}」分析的班表 CSV 檔案。` 
    });
  }

  // --- Existing Conversation State Logic ---
  if (currentState) {
    if (currentState.step === 'awaiting_recurrence_end_condition') {
      return handleRecurrenceResponse(replyToken, message, userId, currentState);
    } else if (currentState.step === 'awaiting_event_title') {
      return handleTitleResponse(replyToken, message, userId, currentState);
    }
  }

  // --- Existing New Command Logic ---
  return handleNewCommand(replyToken, message, userId);
};


// --- 5d. Handle New Text Command ---
const handleNewCommand = async (replyToken: string, message: TextEventMessage, userId: string) => {
  console.log(`Handling new text message: ${message.text}`);
  const parsedResult = await parseTextToCalendarEvent(message.text);

  if ('error' in parsedResult) {
    console.log(`Input ignored: ${parsedResult.error}`);
    return null;
  }

  const event = parsedResult as Partial<CalendarEvent>;

  if (!event.title && event.start) {
    conversationStates.set(userId, { step: 'awaiting_event_title', event, timestamp: Date.now() });
    const timeDetails = new Date(event.start).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short', hour12: false, timeZone: 'Asia/Taipei' });
    return lineClient.replyMessage(replyToken, { type: 'text', text: `好的，請問「${timeDetails}」要安排什麼活動呢？` });
  }

  const fullEvent = event as CalendarEvent;
  return processCompleteEvent(replyToken, fullEvent, userId);
};

// --- 5e. Handle Title Response ---
const handleTitleResponse = async (replyToken: string, message: TextEventMessage, userId: string, currentState: ConversationState) => {
  const completeEvent = { ...currentState.event, title: message.text } as CalendarEvent;
  conversationStates.delete(userId);
  return processCompleteEvent(replyToken, completeEvent, userId);
};

// --- 5f. Handle Recurrence Response ---
const handleRecurrenceResponse = async (replyToken: string, message: TextEventMessage, userId: string, currentState: ConversationState) => {
  const originalEvent = currentState.event as CalendarEvent;
  const recurrenceResult = await parseRecurrenceEndCondition(message.text, originalEvent.recurrence || '', originalEvent.start);

  if ('error' in recurrenceResult) {
    currentState.timestamp = Date.now();
    conversationStates.set(userId, currentState);
    return lineClient.replyMessage(replyToken, { type: 'text', text: `抱歉，我不太理解您的意思。請問您希望這個重複活動什麼時候結束？\n(例如: 直到年底、重複10次、或直到 2025/12/31)` });
  }

  try {
    await lineClient.replyMessage(replyToken, { type: 'text', text: '好的，已為您更新重複規則，正在建立活動... ' });
    const fullEvent: CalendarEvent = { ...originalEvent, recurrence: recurrenceResult.updatedRrule };
    const createdEvent = await createCalendarEvent(fullEvent, fullEvent.calendarId);
    conversationStates.delete(userId);
    return sendCreationConfirmation(userId, fullEvent, createdEvent);
  } catch (error) {
    conversationStates.delete(userId);
    return handleCreateError(error, userId);
  }
};

// --- 5g. Process a complete event ---
const processCompleteEvent = async (replyToken: string, event: CalendarEvent, userId: string, fromImage: boolean = false) => {
  // Gemini may not provide a calendarId, so we default to primary
  if (!event.calendarId) {
    event.calendarId = 'primary';
  }

  if (event.recurrence && !event.recurrence.includes('COUNT') && !event.recurrence.includes('UNTIL')) {
    conversationStates.set(userId, { step: 'awaiting_recurrence_end_condition', event, timestamp: Date.now() });
    const reply: Message = { type: 'text', text: `好的，活動「${event.title}」是一個重複性活動，請問您希望它什麼時候結束？\n(例如: 直到年底、重複10次、或直到 2025/12/31)` };
    return fromImage ? lineClient.pushMessage(userId, reply) : lineClient.replyMessage(replyToken, reply);
  }

  const calendarChoices = await getCalendarChoicesForUser();

  if (calendarChoices.length <= 1) {
    try {
      const reply: Message = { type: 'text', text: '收到指令，正在為您建立活動...' };
      if (!fromImage) await lineClient.replyMessage(replyToken, reply);
      const createdEvent = await createCalendarEvent(event, calendarChoices[0]?.id || 'primary');
      return sendCreationConfirmation(userId, event, createdEvent);
    } catch (error) {
      return handleCreateError(error, userId);
    }
  } else {
    conversationStates.set(userId, { step: 'awaiting_calendar_choice', event, timestamp: Date.now() });

    const timeInfo = formatEventTime(event);
    const actions = calendarChoices.map((choice: CalendarChoice) => ({
      type: 'postback' as const,
      label: choice.summary.substring(0, 20),
      data: new URLSearchParams({ action: 'create', calendarId: choice.id }).toString(),
    }));

    actions.push({
      type: 'postback' as const,
      label: '全部加入',
      data: new URLSearchParams({ action: 'createAll', calendarIds: JSON.stringify(calendarChoices.map((c: CalendarChoice) => c.id)) }).toString(),
    });

    const templateText = `時間：${timeInfo}\n請選擇一個日曆，或選擇「全部加入」。`;

    const template: TemplateMessage = {
      type: 'template',
      altText: `將「${event.title}」新增至日曆`,
      template: {
        type: 'buttons',
        title: `新增活動：${event.title}`,
        text: templateText.substring(0, 160),
        actions: actions,
      },
    };

    return fromImage ? lineClient.pushMessage(userId, template) : lineClient.replyMessage(replyToken, template);
  }
}

// --- 6. Postback Event Handler ---
const handlePostbackEvent = async (event: PostbackEvent) => {
  const { replyToken, postback, source } = event;
  const userId = source.userId;
  if (!userId) return Promise.resolve(null);

  console.log(`Handling postback: ${postback.data}`);
  const params = new URLSearchParams(postback.data);
  const action = params.get('action');
  const currentState = conversationStates.get(userId);

  if (action === 'cancel') {
    conversationStates.delete(userId);
    return lineClient.replyMessage(replyToken, { type: 'text', text: '好的，操作已取消。' });
  }

  if (!currentState || !currentState.event) {
    return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，您的請求已逾時或無效，請重新操作。' });
  }
  const fullEvent = currentState.event as CalendarEvent;

  if (action === 'createAll') {
    const calendarIdsString = params.get('calendarIds');
    if (!calendarIdsString) return Promise.resolve(null);

    try {
      const calendarIds: string[] = JSON.parse(calendarIdsString);
      await lineClient.replyMessage(replyToken, { type: 'text', text: `收到！正在為您在 ${calendarIds.length} 個日曆中新增活動...` });

      const results = await Promise.allSettled(calendarIds.map(calId => createCalendarEvent(fullEvent, calId)));
      conversationStates.delete(userId);

      const calendarChoices = await getCalendarChoicesForUser();
      const calendarNameMap = new Map<string, string>();
      calendarChoices.forEach(c => calendarNameMap.set(c.id, c.summary));

      const alreadyExisted: string[] = [];
      const failed: string[] = [];

      for (const [index, result] of results.entries()) {
        if (result.status === 'rejected') {
          const calId = calendarIds[index];
          const calName = calendarNameMap.get(calId) || calId;
          if (result.reason instanceof DuplicateEventError) {
            alreadyExisted.push(calName);
          } else {
            failed.push(calName);
            console.error(`Failed to create event in ${calName} (${calId}):`, result.reason);
          }
        }
      }

      let summaryText = '';
      if (alreadyExisted.length > 0) {
        summaryText += `🔍 已存在，故跳過：\n- ${alreadyExisted.join('\n- ')}`;
      }
      if (failed.length > 0) {
        if (summaryText) summaryText += '\n\n';
        summaryText += `❌ 新增失敗：\n- ${failed.join('\n- ')}`;
      }

      if (summaryText) {
        await lineClient.pushMessage(userId, { type: 'text', text: summaryText });
      }
      
      await new Promise(resolve => setTimeout(resolve, 1500)); // Mitigate replication lag
      return sendCreationConfirmation(userId, fullEvent);

    } catch (error) {
      conversationStates.delete(userId);
      return handleCreateError(error, userId);
    }
  }

  if (action === 'create') {
    const calendarId = params.get('calendarId') || 'primary';
    try {
      await lineClient.replyMessage(replyToken, { type: 'text', text: `收到！正在為您新增活動至 Google 日曆中...` });
      const createdEvent = await createCalendarEvent(fullEvent, calendarId);
      conversationStates.delete(userId);
      return sendCreationConfirmation(userId, fullEvent, createdEvent);
    } catch (error) {
      conversationStates.delete(userId);
      return handleCreateError(error, userId);
    }
  }

  return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，發生了未知的錯誤。' });
};

// --- 7. Helper Functions ---
const getLineImageBuffer = async (messageId: string): Promise<Buffer> => {
  const stream = await lineClient.getMessageContent(messageId);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

const formatEventTime = (event: Partial<CalendarEvent>): string => {
  let timeInfo = '';
  const { start, end, allDay } = event;

  if (!start || !end) return '';

  if (allDay) {
    const startDate = new Date(start);
    const endDate = new Date(end);
    if (endDate.toISOString().split('T')[0] !== startDate.toISOString().split('T')[0]) {
      endDate.setDate(endDate.getDate() - 1);
    }
    const startDateStr = startDate.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Taipei' });
    if (startDate.toISOString().split('T')[0] === endDate.toISOString().split('T')[0]) {
      timeInfo = `${startDateStr} (全天)`;
    } else {
      const endDateStr = endDate.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Taipei' });
      timeInfo = `${startDateStr} 至 ${endDateStr}`;
    }
  } else {
    const startDate = new Date(start);
    const endDate = new Date(end);
    const startDateStr = startDate.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Taipei' });
    const startTimeStr = startDate.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });
    const endDateStr = endDate.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Taipei' });
    const endTimeStr = endDate.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });
    if (startDateStr === endDateStr) {
      timeInfo = `${startDateStr} ${startTimeStr} - ${endTimeStr}`;
    } else {
      timeInfo = `${startDateStr} ${startTimeStr} - ${endDateStr} ${endTimeStr}`;
    }
  }
  return timeInfo;
}

const sendCreationConfirmation = async (userId: string, event: CalendarEvent, createdEventForSeed?: calendar_v3.Schema$Event) => {
  const allCalendars = await getCalendarChoicesForUser();
  const calendarNameMap = new Map<string, string>();
  allCalendars.forEach(c => calendarNameMap.set(c.id, c.summary));

  const foundInstances: { calName: string, htmlLink: string | null | undefined }[] = [];

  let searchCalendars = allCalendars;
  let seededCalName = '';

  if (createdEventForSeed) {
    const organizerEmail = createdEventForSeed.organizer?.email;
    if (organizerEmail) {
      seededCalName = calendarNameMap.get(organizerEmail) || organizerEmail;
      foundInstances.push({ calName: seededCalName, htmlLink: createdEventForSeed.htmlLink });
      searchCalendars = allCalendars.filter(c => c.id !== organizerEmail);
    }
  }

  const searchPromises = searchCalendars.map(cal => 
    calendar.events.list({
      calendarId: cal.id,
      q: event.title,
      timeMin: event.start,
      timeMax: event.end,
      singleEvents: true,
    }).then((res: { data: calendar_v3.Schema$Events }) => ({
      ...res, 
      calName: cal.summary // Pass calendar name through
    }))
  );

  const searchResults = await Promise.allSettled(searchPromises);

  for (const result of searchResults) {
    if (result.status === 'fulfilled' && result.value.data.items) {
      for (const item of result.value.data.items) {
        if (item.summary === event.title) {
          let isMatch = false;
          if (event.allDay) {
            if (item.start?.date === event.start.split('T')[0]) {
              isMatch = true;
            }
          } else {
            if (item.start?.dateTime) {
              const eventStartTime = new Date(event.start).getTime();
              const itemStartTime = new Date(item.start.dateTime).getTime();
              if (eventStartTime === itemStartTime) {
                isMatch = true;
              }
            }
          }

          if (isMatch) {
            foundInstances.push({ calName: result.value.calName, htmlLink: item.htmlLink });
            break; // Found in this calendar, move to the next
          }
        }
      }
    }
  }

  if (foundInstances.length === 0) {
    return lineClient.pushMessage(userId, { type: 'text', text: `✅ 活動「${event.title}」已成功新增，但無法立即取得活動連結。` });
  }

  if (foundInstances.length === 1) {
    const item = foundInstances[0];
    const timeInfo = formatEventTime(event);
    const buttonTemplate: TemplateMessage = {
      type: 'template',
      altText: `活動「${event.title}」已新增`,
      template: {
        type: 'buttons',
        title: `✅ ${event.title.substring(0, 40)}`,
        text: `時間：${timeInfo}\n已新增至「${item.calName}」日曆`.substring(0, 160),
        actions: [{
          type: 'uri',
          label: '在 Google 日曆中查看',
          uri: item.htmlLink!
        }]
      }
    };
    return lineClient.pushMessage(userId, buttonTemplate);
  }

  // More than 1, use carousel
  const headerText = `✅ 活動「${event.title}」目前存在於 ${foundInstances.length} 個日曆中。`;
  const timeInfo = formatEventTime(event);
  const carouselTemplate: TemplateMessage = {
    type: 'template',
    altText: '查看新建立的活動',
    template: {
      type: 'carousel',
      columns: foundInstances.slice(0, 10).map(item => ({
        title: event.title.substring(0, 40),
        text: `時間：${timeInfo}\n存在於「${item.calName}」日曆`.substring(0, 60),
        actions: [{
          type: 'uri',
          label: '在 Google 日曆中查看',
          uri: item.htmlLink!
        }]
      }))
    }
  };
  return lineClient.pushMessage(userId, [ { type: 'text', text: headerText }, carouselTemplate ]);
};

const handleCreateError = (error: any, userId: string) => {
  if (error instanceof DuplicateEventError) {
    const duplicateButtonTemplate: TemplateMessage = {
      type: 'template',
      altText: '活動已存在',
      template: {
        type: 'buttons',
        title: '🔍 活動已存在',
        text: '這個活動先前已經在日曆中囉！',
        actions: [{
          type: 'uri',
          label: '點擊查看',
          uri: error.htmlLink!
        }]
      }
    };
    return lineClient.pushMessage(userId, duplicateButtonTemplate);
  }
  console.error("!!!!!!!!!! DETAILED ERROR REPORT START !!!!!!!!!!");
  console.error(JSON.stringify(error, null, 2));
  console.error("!!!!!!!!!! DETAILED ERROR REPORT END !!!!!!!!!!");
  return lineClient.pushMessage(userId, { type: 'text', text: '抱歉，新增日曆事件時發生錯誤，請稍後再試。' });
};

// --- Local Development & Vercel Entry Point ---
if (require.main === module) {
  const port = process.env.PORT || 3000;
  app.listen(port, () => console.log(`[Local] Server is listening on http://localhost:${port}`));
}
export default app;
