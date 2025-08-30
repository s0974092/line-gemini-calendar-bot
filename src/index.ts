import 'dotenv/config';
import express, { Request, Response } from 'express';
import {
  Client,
  middleware,
  WebhookEvent,
  MiddlewareConfig,
  ClientConfig,
  TextMessage,
  TemplateMessage,
  PostbackEvent,
} from '@line/bot-sdk';
import {
  parseTextToCalendarEvent,
  CalendarEvent,
  parseRecurrenceEndCondition,
  translateRruleToHumanReadable
} from './services/geminiService';
import { createCalendarEvent, DuplicateEventError } from './services/googleCalendarService';

// --- 1. Configuration ---
if (!process.env.LINE_CHANNEL_SECRET || !process.env.LINE_CHANNEL_ACCESS_TOKEN) {
  throw new Error('Missing LINE channel secret or access token');
}
const lineConfig: MiddlewareConfig = { channelSecret: process.env.LINE_CHANNEL_SECRET };
const clientConfig: ClientConfig = { channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN };
const lineClient = new Client(clientConfig);
const userWhitelist: string[] = (process.env.USER_WHITELIST || '').split(',');

// --- 2. In-Memory Conversation State & Payloads ---
interface ConversationState {
  step: 'awaiting_recurrence_end_condition' | 'awaiting_event_title';
  event: Partial<CalendarEvent>; // Event can be incomplete during conversation
  timestamp: number; // To handle timeouts
}
const conversationStates = new Map<string, ConversationState>();

interface PostbackEventPayload {
  title: string;
  start: string;
  end: string;
  allDay: boolean;
}

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

  switch (event.type) {
    case 'message':
      if (event.message.type === 'text') {
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

// --- 5. Text Message Handler ---
const handleTextMessage = async (replyToken: string, message: TextMessage, userId: string) => {
  let currentState = conversationStates.get(userId);
  const now = Date.now();
  const fifteenMinutes = 15 * 60 * 1000;

  if (currentState && now - currentState.timestamp > fifteenMinutes) {
    console.log(`State for user ${userId} has expired. Clearing state.`);
    conversationStates.delete(userId);
    currentState = undefined;
  }

  if (currentState) {
    if (currentState.step === 'awaiting_recurrence_end_condition') {
      return handleRecurrenceResponse(replyToken, message, userId, currentState);
    } else if (currentState.step === 'awaiting_event_title') {
      return handleTitleResponse(replyToken, message, userId, currentState);
    }
  }

  return handleNewCommand(replyToken, message, userId);
};

// --- 5a. Handle New Command ---
const handleNewCommand = async (replyToken: string, message: TextMessage, userId: string) => {
  console.log(`Handling new text message: ${message.text}`);
  const parsedResult = await parseTextToCalendarEvent(message.text);

  if ('error' in parsedResult) {
    console.log(`Input ignored: ${parsedResult.error}`);
    return null;
  }

  const event = parsedResult as Partial<CalendarEvent>;

  // Case 1: Incomplete event (missing title) -> Ask for title
  if (!event.title && event.start) {
    conversationStates.set(userId, { step: 'awaiting_event_title', event, timestamp: Date.now() });
    const timeDetails = new Date(event.start).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short', hour12: false, timeZone: 'Asia/Taipei' });
    return lineClient.replyMessage(replyToken, {
      type: 'text', 
      text: `好的，請問「${timeDetails}」要安排什麼活動呢？`
    });
  }

  // If we get here, the event should be complete. Cast it to the full type.
  const fullEvent = event as CalendarEvent;
  return processCompleteEvent(replyToken, fullEvent, userId);
};

// --- 5b. Handle Title Response ---
const handleTitleResponse = async (replyToken: string, message: TextMessage, userId: string, currentState: ConversationState) => {
  console.log(`Handling response for event title: "${message.text}"`);
  
  // Combine the new title with the previous event data
  const completeEvent = { ...currentState.event, title: message.text } as CalendarEvent;

  // Clear the state now that we have a complete event
  conversationStates.delete(userId);

  // Now that the event is complete, process it as if it were a new, complete command
  return processCompleteEvent(replyToken, completeEvent, userId);
};

// --- 5c. Handle Recurrence Response ---
const handleRecurrenceResponse = async (replyToken: string, message: TextMessage, userId: string, currentState: ConversationState) => {
  console.log(`Handling response for recurrence end condition: "${message.text}"`);
  const originalEvent = currentState.event as CalendarEvent;

  const recurrenceResult = await parseRecurrenceEndCondition(message.text, originalEvent.recurrence || '', originalEvent.start);

  if ('error' in recurrenceResult) {
    console.log('Failed to parse recurrence end condition. Asking again.');
    currentState.timestamp = Date.now();
    conversationStates.set(userId, currentState);
    return lineClient.replyMessage(replyToken, {
      type: 'text',
      text: `抱歉，我不太理解您的意思。請問您希望這個重複活動什麼時候結束呢？\n(例如: 直到年底、重複10次、或直到 2025/12/31)`,
    });
  }

  try {
    await lineClient.replyMessage(replyToken, { type: 'text', text: '好的，已為您更新重複規則，正在建立活動... ' });
    const fullEvent: CalendarEvent = { ...originalEvent, recurrence: recurrenceResult.updatedRrule };
    const createdEvent = await createCalendarEvent(fullEvent);
    conversationStates.delete(userId);
    const successMessage = await createSuccessMessage(createdEvent);
    return lineClient.pushMessage(userId, { type: 'text', text: successMessage });
  } catch (error) {
    conversationStates.delete(userId);
    return handleCreateError(error, userId);
  }
};

// --- 5d. Process a complete event ---
const processCompleteEvent = async (replyToken: string, event: CalendarEvent, userId: string) => {
  // Case 1: Incomplete recurring event -> Ask for end condition
  if (event.recurrence && !event.recurrence.includes('COUNT') && !event.recurrence.includes('UNTIL')) {
    conversationStates.set(userId, { step: 'awaiting_recurrence_end_condition', event, timestamp: Date.now() });
    return lineClient.replyMessage(replyToken, {
      type: 'text',
      text: `好的，活動「${event.title}」是一個重複性活動，請問您希望它什麼時候結束？\n(例如: 直到年底、重複10次、或直到 2025/12/31)`,
    });
  }

  // Case 2: Complete recurring event -> Create directly
  if (event.recurrence) {
    try {
      await lineClient.replyMessage(replyToken, { type: 'text', text: '收到完整的重複活動指令，正在為您建立...' });
      const createdEvent = await createCalendarEvent(event);
      const successMessage = await createSuccessMessage(createdEvent);
      return lineClient.pushMessage(userId, { type: 'text', text: successMessage });
    } catch (error) {
      return handleCreateError(error, userId);
    }
  }

  // Case 3: Single event -> Show confirmation card
  const formatTime = (isoString: string) => new Date(isoString).toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Taipei' });
  const formatDate = (isoString: string) => new Date(isoString).toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit' });
  const timeDetailsText = event.allDay
    ? `${formatDate(event.start)} (全天)`
    : `${formatDate(event.start)} ${formatTime(event.start)} - ${formatTime(event.end)}`;
  const confirmationText = `標題：${event.title} | 時間：${timeDetailsText}`;

  const eventForPostback: PostbackEventPayload = { title: event.title, start: event.start, end: event.end, allDay: event.allDay };
  const postbackData = new URLSearchParams({ action: 'create', event: JSON.stringify(eventForPostback) }).toString();

  const confirmationTemplate: TemplateMessage = {
    type: 'template',
    altText: '需要您的確認',
    template: {
      type: 'buttons',
      title: '收到您有新活動！您要新增至日曆嗎？',
      text: confirmationText,
      actions: [
        { type: 'postback', label: '新增', data: postbackData },
      ],
    },
  };

  return lineClient.replyMessage(replyToken, confirmationTemplate);
}

// --- 6. Postback Event Handler ---
const handlePostbackEvent = async (event: PostbackEvent) => {
  const { replyToken, postback, source } = event;
  const userId = source.userId;
  if (!userId) return Promise.resolve(null);

  console.log(`Handling postback: ${postback.data}`);
  const params = new URLSearchParams(postback.data);
  const action = params.get('action');

  if (conversationStates.has(userId)) {
    conversationStates.delete(userId);
    console.log(`Cleared stale conversation state for user ${userId} due to new postback.`);
  }

  if (action === 'cancel') {
    return lineClient.replyMessage(replyToken, { type: 'text', text: '好的，操作已取消。' });
  }

  if (action === 'create') {
    const eventString = params.get('event');
    if (!eventString) return Promise.resolve(null);
    try {
      const postbackEvent: PostbackEventPayload = JSON.parse(decodeURIComponent(eventString));
      const fullEvent: CalendarEvent = { ...postbackEvent, recurrence: null, reminder: 30, calendarId: 'primary' };
      await lineClient.replyMessage(replyToken, { type: 'text', text: `收到！正在為您新增活動至 Google 日曆中...` });
      const createdEvent = await createCalendarEvent(fullEvent);
      const successMessage = await createSuccessMessage(createdEvent);
      return lineClient.pushMessage(userId, { type: 'text', text: successMessage });
    } catch (error) {
      return handleCreateError(error, userId);
    }
  }

  return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，發生了未知的錯誤。' });
};

// --- 7. Helper Functions ---
const createSuccessMessage = async (createdEvent: any): Promise<string> => {
  let recurrenceDescription = '';
  if (createdEvent.recurrence && createdEvent.recurrence[0]) {
    try {
      const translationResult = await translateRruleToHumanReadable(createdEvent.recurrence[0]);
      if (!('error' in translationResult)) {
        recurrenceDescription = `\n- 重複規則：${translationResult.description}`;
      }
    } catch (e) {
      console.error('Failed to translate RRULE, falling back to raw string.', e);
      recurrenceDescription = `\n- 重複規則：${createdEvent.recurrence[0]}`;
    }
  }

  let timeInfo = '';
  const { start, end } = createdEvent;

  if (start.date) { // All-day event
    const startDate = new Date(start.date + 'T00:00:00');
    const endDate = new Date(end.date);
    endDate.setDate(endDate.getDate() - 1);

    const startDateStr = startDate.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Taipei' });

    if (startDate.getTime() === endDate.getTime()) {
      timeInfo = `${startDateStr} (全天)`;
    } else {
      const endDateStr = endDate.toLocaleDateString('zh-TW', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone: 'Asia/Taipei' });
      timeInfo = `${startDateStr} 至 ${endDateStr}`;
    }
  } else if (start.dateTime) { // Event with specific time
    const startDate = new Date(start.dateTime);
    const endDate = new Date(end.dateTime);

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

  return `✅ 事件已成功新增！\n\n- 標題：${createdEvent.summary}\n- 時間：${timeInfo}${recurrenceDescription}\n\n您可以點擊下方連結查看：\n${createdEvent.htmlLink}`;
};

const handleCreateError = (error: any, userId: string) => {
  if (error instanceof DuplicateEventError) {
    return lineClient.pushMessage(userId, { type: 'text', text: `這個活動先前已經新增成功囉！\n\n您可以點擊下方連結查看：\n${error.htmlLink}` });
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