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
  Action,
  FlexMessage,
  FlexBubble,
  FlexCarousel,
} from '@line/bot-sdk';
import { calendar_v3 } from 'googleapis';
import {
  classifyIntent,
  Intent,
  CalendarEvent,
  parseRecurrenceEndCondition,
  parseEventChanges,
  translateRruleToHumanReadable,
} from './services/geminiService';
import {
  calendar,
  createCalendarEvent,
  DuplicateEventError,
  getCalendarChoicesForUser,
  CalendarChoice,
  searchEvents,
  findEventsInTimeRange,
  updateEvent,
  deleteEvent,
} from './services/googleCalendarService';
import { Stream } from 'stream';
import { parseCsvToEvents, parseXlsxToEvents } from './utils/excelParser';
import Redis from 'ioredis'; // Import Redis
import { formatEventTime } from './utils/time';
import { handleCreateError } from './utils/errorHandler';
import { createEventFlexBubble } from './utils/flexMessages';

// --- 1. 設定 ---
if (!process.env.LINE_CHANNEL_SECRET || !process.env.LINE_CHANNEL_ACCESS_TOKEN) {
  throw new Error('Missing LINE channel secret or access token');
}
const lineConfig: MiddlewareConfig = { channelSecret: process.env.LINE_CHANNEL_SECRET };
const clientConfig: ClientConfig = { channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN };
const lineClient = new Client(clientConfig);
const userWhitelist: string[] = (process.env.USER_WHITELIST || '').split(',');

const welcomeMessage = `哈囉！我是您的 AI 日曆助理。用自然語言輕鬆管理 Google 日曆！

您可以這樣對我說：

  🗓️ 新增活動：
   * 
明天早上9點開會
   * 
9月15號下午三點跟John面試
   * 
10/1 14:00 專案會議 地點在301會議室 備註：討論Q4目標
   * 
每週一早上9點的站立會議
 (會追問結束條件)
   * 
11/1到11/11每天早上十點到十二點開會

  🔍 查詢活動：
   * 
明天有什麼事
   * 
下週有什麼活動
   * 
我什麼時候要跟John面試

  ✏️ 修改活動：
   * 
把明天下午3點的會議改到下午4點
   * 
修改後天的會議
 (會反問您想修改的內容，可包含地點、備註)

  🗑️ 刪除活動：
   * 
取消明天下午3點的會議

  📊 班表建立 (支援 CSV / XLSX！)：
   * 想整理班表？請先說 
幫我建立[人名]的班表
 ，再傳 CSV 或 XLSX 格式檔案。圖片還在學！

若在對話中想中斷操作，隨時可輸入 
取消
 。
請盡量使用自然語言描述您的需求，我會盡力理解！

💡 小提示：隨時輸入「功能列表」或「你會什麼」，就可以再次看到這個功能選單喔！`;

// --- 2. 記憶體內狀態 & 酬載 ---

// 用於多輪對話
interface ConversationState {
  step: 'awaiting_recurrence_end_condition' | 'awaiting_event_title' | 'awaiting_bulk_confirmation' | 'awaiting_csv_upload' | 'awaiting_calendar_choice' | 'awaiting_conflict_confirmation' | 'awaiting_modification_details' | 'awaiting_delete_confirmation';
  event?: Partial<CalendarEvent>; // 用於單一事件建立
  events?: CalendarEvent[]; // 用於批次事件建立
  personName?: string; // 用於班表圖片分析
  timestamp: number; // 用於處理超時
  eventId?: string; // 用於修改/刪除
  calendarId?: string; // 用於修改/刪除
  chatId?: string; // The ID of the chat (group, room, or user) where the conversation started
}

// 使用 Redis 儲存對話狀態
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

redis.on('error', (err) => {
  console.error('Redis Error:', err);
});

// 輔助函式：從事件中取得聊天室 ID
function getChatId(event: WebhookEvent): string {
  const source = event.source;
  if (source.type === 'group') {
    return source.groupId;
  } else if (source.type === 'room') {
    return source.roomId;
  } else {
    return source.userId!;
  }
}

// 輔助函式：產生用於 Redis 的複合鍵
function getCompositeKey(userId: string, chatId?: string): string {
  // 如果提供了 chatId，則使用複合鍵，以區分不同對話。
  // 否則，使用舊的 userId 單一鍵，以保持向下相容。
  return chatId ? `state:${userId}:${chatId}` : userId;
}

// 輔助函式：從 Redis 取得對話狀態
async function getConversationState(userId: string, chatId?: string): Promise<ConversationState | undefined> {
  const key = getCompositeKey(userId, chatId);
  const stateJson = await redis.get(key);
  if (stateJson) {
    return JSON.parse(stateJson) as ConversationState;
  }
  // 如果複合鍵找不到，嘗試用舊的單一鍵尋找，以處理進行中的舊對話。
  if (chatId) {
    const oldStateJson = await redis.get(userId);
    return oldStateJson ? JSON.parse(oldStateJson) : undefined;
  }
  return undefined;
}

// 輔助函式：設定對話狀態到 Redis (設定 1 小時過期)
async function setConversationState(userId: string, state: ConversationState, chatId?: string): Promise<void> {
  const key = getCompositeKey(userId, chatId);
  // 將 chatId 儲存到狀態物件中，以便後續流程可以取用
  const stateToSave: ConversationState = { ...state, chatId: chatId || userId };
  await redis.set(key, JSON.stringify(stateToSave), 'EX', 3600);
}

// 輔助函式：從 Redis 清除對話狀態
async function clearConversationState(userId: string, chatId?: string): Promise<void> {
  const key = getCompositeKey(userId, chatId);
  await redis.del(key);
  // 同時也嘗試刪除舊的鍵，以完成遷移
  if (chatId) {
    await redis.del(userId);
  }
}


// --- 3. Express 應用程式設定 ---
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

// --- 4. 主要事件路由 (新增全域錯誤處理) ---
const handleEvent = async (event: WebhookEvent) => {
  let userId: string | undefined;
  // 從事件來源取得 userId
  if (event.source) {
    userId = event.source.userId;
  }

  try {
    // 驗證白名單 (除了 join 事件)
    if (event.type !== 'join') {
      if (!userId || !userWhitelist.includes(userId)) {
        console.log(`Rejected event from non-whitelisted user: ${userId}`);
        return null;
      }
    }

    // 通用狀態超時檢查
    if (userId) {
      const currentState = await getConversationState(userId);
      if (currentState && (Date.now() - currentState.timestamp > 10 * 60 * 1000)) { // 10 分鐘超時
        console.log(`State for user ${userId} has expired.`);
        await clearConversationState(userId);
      }
    }

    switch (event.type) {
      case 'message':
        if (event.message.type === 'file') {
          return handleFileMessage(event.replyToken, event.message as FileEventMessage, userId!, event);
        } else if (event.message.type === 'image') {
          return handleImageMessage(event.replyToken, event.message, userId!);
        } else if (event.message.type === 'text') {
          return handleTextMessage(event.replyToken, event.message, userId!, event);
        }
        return null;
      case 'postback':
        return handlePostbackEvent(event);
      case 'join':

        let targetId: string | undefined;
        if (event.source.type === 'group') {
          targetId = event.source.groupId;
        } else if (event.source.type === 'room') {
          targetId = event.source.roomId;
        }

        if (targetId) {
          console.log(`Bot joined ${event.source.type}: ${targetId}. Sending welcome message.`);
          await lineClient.pushMessage(targetId, { type: 'text', text: welcomeMessage });
        }
        return null;
      default:
        console.log(`Unhandled event type: ${event.type}`);
        return null;
    }
  } catch (error) {
    // 全域錯誤處理
    // 對於其他錯誤，記錄並重新拋出，由頂層處理器捕捉
    console.error(`Unhandled error in handleEvent for user ${userId}:`, error);
    throw error;
  }
};

// --- 5. 訊息處理器 ---

// --- 5a. 圖片訊息處理器 (新流程) ---
// 注意：此流程暫時停用，改用基於 CSV 的排程。
const handleImageMessage = async (replyToken: string, message: ImageEventMessage, userId: string) => {
  return lineClient.replyMessage(replyToken, { type: 'text', text: '圖片班表功能已暫停，請改用「幫 [姓名] 建立班表」指令來上傳 CSV 檔案。' });
};

// 將串流轉換為字串的輔助函式
const streamToString = (stream: Stream): Promise<string> => {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
  });
};

// 將串流轉換為 Buffer 的輔助函式 (新增)
const streamToBuffer = (stream: Stream): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    stream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    stream.on('error', (err) => reject(err));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
};

const handleFileMessage = async (replyToken: string, message: FileEventMessage, userId: string, event: WebhookEvent) => {
  const chatId = getChatId(event);
  const currentState = await getConversationState(userId, chatId);

  // 檢查這是否是一個班表上傳的流程
  if (!currentState || currentState.step !== 'awaiting_csv_upload' || !currentState.personName) {
    return lineClient.replyMessage(replyToken, { type: 'text', text: '感謝您傳送檔案，但我不知道該如何處理它。如果您想建立班表，請先傳送「幫 [姓名] 建立班表」。' });
  }

  // 從這裡開始，我們確定這是在正確的上下文中上傳的班表檔案
  const personName = currentState.personName;
  const lowerCaseFileName = message.fileName.toLowerCase();
  const isCsv = lowerCaseFileName.endsWith('.csv');
  const isXlsx = lowerCaseFileName.endsWith('.xlsx');

  if (!isCsv && !isXlsx) {
    return lineClient.replyMessage(replyToken, { type: 'text', text: '檔案格式錯誤，請上傳 .csv 或 .xlsx 格式的班表檔案。' });
  }

  console.log(`File received for schedule analysis for person: "${personName}" in chat ${chatId}`);

  try {
    const fileContentStream = await lineClient.getMessageContent(message.id);
    const fileBuffer = await streamToBuffer(fileContentStream);
    let events: CalendarEvent[];

    try {
      if (isCsv) {
        const fileContent = fileBuffer.toString('utf8');
        events = parseCsvToEvents(fileContent, personName);
      } else { // isXlsx
        events = parseXlsxToEvents(fileBuffer, personName);
      }
    } catch (parseError) {
      console.error(`Error parsing ${isCsv ? 'CSV' : 'XLSX'}:`, parseError);
      await clearConversationState(userId, chatId);
      const fileType = isCsv ? 'CSV' : 'XLSX';
      return lineClient.replyMessage(replyToken, { type: 'text', text: `處理您上傳的 ${fileType} 檔案時發生錯誤，請檢查並確認檔案是否正確。` });
    }

    // 清除舊的 'awaiting_csv_upload' 狀態
    await clearConversationState(userId, chatId); // <-- Use composite key

    if (events.length === 0) {
      return lineClient.replyMessage(replyToken, { type: 'text', text: `在您上傳的班表檔案中，找不到「${personName}」的任何班次，或格式不正確。` });
    }

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

    // 設定下一步 'awaiting_bulk_confirmation' 的狀態，同樣使用複合鍵
    await setConversationState(userId, { step: 'awaiting_bulk_confirmation', events, timestamp: Date.now() }, chatId); // <-- Use composite key

    const calendarChoices = await getCalendarChoicesForUser();
    let confirmationTemplate: TemplateMessage;
    if (calendarChoices.length <= 1) {
      const summaryText = `您要將這 ${events.length} 個活動一次全部新增至您的 Google 日曆嗎？`;
      confirmationTemplate = {
        type: 'template',
        altText: '需要您確認批次新增活動',
        template: {
          type: 'buttons',
          title: `為 ${personName} 批次新增活動`,
          text: summaryText,
          actions: [
            { type: 'postback', label: '全部新增', data: `action=createAllShifts&calendarId=${calendarChoices[0]?.id || 'primary'}` },
            { type: 'postback', label: '取消', data: 'action=cancel' },
          ],
        },
      };
    } else {
      const maxCalendarActions = 3;
      const actions: Action[] = calendarChoices.slice(0, maxCalendarActions).map((choice: CalendarChoice) => ({
        type: 'postback' as const,
        label: choice.summary.substring(0, 20),
        data: `action=createAllShifts&calendarId=${choice.id}`,
      }));

      actions.push({ type: 'postback', label: '取消', data: 'action=cancel' });

      confirmationTemplate = {
        type: 'template',
        altText: '請選擇要新增的日曆',
        template: {
          type: 'buttons',
          title: `為 ${personName} 批次新增活動`,
          text: `偵測到您有多個日曆，請問您要將這 ${events.length} 個活動新增至哪個日曆？`,
          actions: actions,
        },
      };
    }

    return lineClient.replyMessage(replyToken, [summaryMessage, confirmationTemplate]);

  } catch (error) {
    console.error('Error processing uploaded file:', error, (error as Error).stack);
    await clearConversationState(userId, chatId); // <-- Use composite key
    return lineClient.replyMessage(replyToken, { type: 'text', text: '處理您上傳的檔案時發生錯誤。' });
  }
};

// --- 5b. 文字訊息處理器 (新流程) ---
const handleTextMessage = async (replyToken: string, message: TextEventMessage, userId: string, event: WebhookEvent) => {
  const text = message.text.trim().toLowerCase();
  const helpKeywords = ['help', '幫助', '你會什麼', '你可以做什麼', '功能列表', '功能'];
  if (helpKeywords.some(keyword => text.includes(keyword))) {
    return lineClient.replyMessage(replyToken, { type: 'text', text: welcomeMessage });
  }

  const chatId = getChatId(event);
  const currentState = await getConversationState(userId, chatId);

  // --- 新增班表分析觸發器 ---
  const nameMatch = message.text.match(/幫(?:「|『)?(.+?)(?:」|『)?建立班表/);
  if (nameMatch) {
    const personName = nameMatch[1].trim();
    console.log(`Request to create schedule for "${personName}". Awaiting CSV file.`);
    await setConversationState(userId, {
      step: 'awaiting_csv_upload',
      personName: personName,
      timestamp: Date.now()
    }, chatId);
    return lineClient.replyMessage(replyToken, {
      type: 'text',
      text: `好的，請現在傳送您要為「${personName}」分析的班表 CSV 或 XLSX 檔案。`
    });
  }

  // --- 新增：通用取消指令 ---
  if (message.text === '取消' || message.text.toLowerCase() === 'cancel') {
    if (currentState) {
      await clearConversationState(userId, chatId);
      return lineClient.replyMessage(replyToken, { type: 'text', text: '好的，操作已取消。' });
    }
  }

  // --- 現有的對話狀態邏輯 ---
  if (currentState) {
    if (currentState.step === 'awaiting_recurrence_end_condition') {
      return handleRecurrenceResponse(replyToken, message, userId, currentState);
    } else if (currentState.step === 'awaiting_event_title') {
      return handleTitleResponse(replyToken, message, userId, currentState);
    } else if (currentState.step === 'awaiting_modification_details') {
      return handleEventUpdate(replyToken, message, userId, currentState);
    }
  }

  // --- 現有的新指令邏輯 ---
  return handleNewCommand(replyToken, message, userId, chatId);
};





// --- 5d. 處理新文字指令 ---
const handleNewCommand = async (replyToken: string, message: TextEventMessage, userId: string, chatId: string) => {
  console.log(`Handling new text message with intent classification: ${message.text}`);
  const intent = await classifyIntent(message.text);

  switch (intent.type) {
    case 'create_event':
      const event = intent.event as Partial<CalendarEvent>;

      // FIX: Default end time to 1 hour after start if not provided
      if (event.start && !event.end) {
        const startDate = new Date(event.start);
        startDate.setHours(startDate.getHours() + 1);
        event.end = startDate.toISOString();
        console.log(`Event end time was missing, defaulted to: ${event.end}`);
      }

      if (!event.title && event.start) {
        await setConversationState(userId, { step: 'awaiting_event_title', event, timestamp: Date.now() }, chatId);
        const timeDetails = new Date(event.start).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short', hour12: false, timeZone: 'Asia/Taipei' });
        return lineClient.replyMessage(replyToken, { type: 'text', text: `好的，請問「${timeDetails}」要安排什麼活動呢？` });
      }
      return processCompleteEvent(replyToken, event as CalendarEvent, userId, chatId);

    case 'query_event':
      console.log(`Handling query_event with query: "${intent.query}" from ${intent.timeMin} to ${intent.timeMax}`);

      const calendarChoicesQuery = await getCalendarChoicesForUser();
      const allCalendarIdsQuery = calendarChoicesQuery.map(c => c.id!);
      const searchPromises = allCalendarIdsQuery.map(calId =>
        searchEvents(calId, intent.timeMin, intent.timeMax, intent.query)
      );
      const searchResults = await Promise.all(searchPromises);

      const foundEvents = searchResults.flatMap(result => result.events);
      const hasMore = searchResults.some(result => !!result.nextPageToken);

      // Sort events by start time
      foundEvents.sort((a, b) => {
        const timeA = new Date(a.start?.dateTime || a.start?.date || 0).getTime();
        const timeB = new Date(b.start?.dateTime || b.start?.date || 0).getTime();
        return timeA - timeB;
      });

      return handleQueryResults(replyToken, intent.query, foundEvents, hasMore);

    case 'update_event':
      console.log(`Handling update_event with query: "${intent.query}" from ${intent.timeMin} to ${intent.timeMax}`);

      const calendarChoicesUpdate = await getCalendarChoicesForUser();
      const allCalendarIdsUpdate = calendarChoicesUpdate.map(c => c.id!);

      const updateSearchPromises = allCalendarIdsUpdate.map(calId =>
        searchEvents(calId, intent.timeMin, intent.timeMax, intent.query)
      );
      const eventsToUpdate = (await Promise.all(updateSearchPromises)).flatMap(r => r.events);

      if (eventsToUpdate.length === 0) {
        return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，找不到您想修改的活動。' });
      }

      if (eventsToUpdate.length === 1 && intent.changes && Object.keys(intent.changes).length > 0) {
        const eventToUpdate = eventsToUpdate[0];
        const eventId = eventToUpdate.id!;
        const calendarId = eventToUpdate.organizer!.email!;

        try {
          const eventPatch: calendar_v3.Schema$Event = {};
          const { title, start, end, location, description } = intent.changes;
          if (title) eventPatch.summary = title;
          if (start) {
            if (start.includes('T')) {
              eventPatch.start = { dateTime: start, date: null, timeZone: 'Asia/Taipei' };
            } else {
              eventPatch.start = { date: start, dateTime: null };
            }
          }
          if (end) {
            if (end.includes('T')) {
              eventPatch.end = { dateTime: end, date: null, timeZone: 'Asia/Taipei' };
            } else {
              eventPatch.end = { date: end, dateTime: null };
            }
          }
          if (location) eventPatch.location = location;
          if (description) eventPatch.description = description;

          const updatedEvent = await updateEvent(eventId, calendarId, eventPatch);
          const flexBubble = await createEventFlexBubble(updatedEvent, '✅ 活動已更新');
          const confirmationMessage: FlexMessage = {
            type: 'flex',
            altText: `活動已更新：${updatedEvent.summary || ''}`.substring(0, 400),
            contents: flexBubble,
          };
          return lineClient.replyMessage(replyToken, confirmationMessage);
        } catch (error) {
          console.error('Error updating event directly:', error);
          return lineClient.pushMessage(userId, { type: 'text', text: '抱歉，更新活動時發生錯誤。' });
        }
      }

      if (eventsToUpdate.length > 1) {
        await setConversationState(userId, { step: 'awaiting_modification_details', eventId: '', timestamp: Date.now() }, chatId);
        const bubbles = await Promise.all(eventsToUpdate.slice(0, 10).map(async event => await createEventFlexBubble(event, event.summary!)));
        const carousel: FlexMessage = {
          type: 'flex',
          altText: '請選擇要修改的活動',
          contents: {
            type: 'carousel',
            contents: bubbles,
          }
        };
        return lineClient.replyMessage(replyToken, [{ type: 'text', text: '我找到了多個符合條件的活動，請選擇您想修改的是哪一個？' }, carousel]);
      }

      const eventToModify = eventsToUpdate[0];
      await setConversationState(userId, {
        step: 'awaiting_modification_details',
        eventId: eventToModify.id!,
        calendarId: eventToModify.organizer!.email!,
        timestamp: Date.now(),
      }, chatId);
      const flexBubble = await createEventFlexBubble(eventToModify, '我找到了這個活動');
      const eventCard: FlexMessage = {
        type: 'flex',
        altText: `活動資訊：${eventToModify.summary || ''}`.substring(0, 400),
        contents: flexBubble,
      };
      return lineClient.replyMessage(replyToken, [
        eventCard,
        { type: 'text', text: '請問您想如何修改這個活動？\n(例如：標題改為「團隊午餐」、時間改到明天下午一點、地點在公司餐廳、加上備註「討論Q4規劃」)\n\n若不需要做修改，請輸入「取消」。' }
      ]);

    case 'delete_event':
      console.log(`Handling delete_event with query: "${intent.query}" from ${intent.timeMin} to ${intent.timeMax}`);
      const calendarChoicesDelete = await getCalendarChoicesForUser();
      const allCalendarIdsDelete = calendarChoicesDelete.map(c => c.id!);

      const deleteSearchPromises = allCalendarIdsDelete.map(calId =>
        searchEvents(calId, intent.timeMin, intent.timeMax, intent.query)
      );
      const eventsToDelete = (await Promise.all(deleteSearchPromises)).flatMap(r => r.events);

      if (eventsToDelete.length === 0) {
        return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，找不到您想刪除的活動。' });
      }

      if (eventsToDelete.length === 1) {
        const event = eventsToDelete[0];
        const eventId = event.id!;
        const calendarId = event.organizer!.email!;

        await setConversationState(userId, {
          step: 'awaiting_delete_confirmation',
          eventId: eventId,
          calendarId: calendarId,
          timestamp: Date.now(),
        }, chatId);

        const template: TemplateMessage = {
          type: 'template',
          altText: `確認刪除活動： ${event.summary}`.substring(0, 400),
          template: {
            type: 'confirm',
            text: `您確定要刪除活動「${event.summary}」嗎？此操作無法復原。`,
            actions: [
              { type: 'postback', label: '確定刪除', data: 'action=confirm_delete' },
              { type: 'postback', label: '取消', data: 'action=cancel' },
            ],
          },
        };
        return lineClient.replyMessage(replyToken, template);
      }

      return lineClient.replyMessage(replyToken, { type: 'text', text: '我找到了多個符合條件的活動，請您先用「查詢」功能找到想刪除的活動，然後再點擊該活動下方的「刪除」按鈕。' });

    case 'create_schedule':
      console.log(`Request to create schedule for "${intent.personName}". Awaiting CSV file.`);
      await setConversationState(userId, {
        step: 'awaiting_csv_upload',
        personName: intent.personName,
        timestamp: Date.now()
      }, chatId);
      return lineClient.replyMessage(replyToken, {
        type: 'text',
        text: `好的，請現在傳送您要為「${intent.personName}」分析的班表 CSV 或 XLSX 檔案。`
      });

    case 'incomplete':
    case 'unknown':
      console.log(`Intent was incomplete or unknown for text: "${intent.originalText}"`);
      return null;
    default:
      console.log(`Unhandled intent type: ${(intent as any).type}`);
      return null;
  }
};
// --- New helper function to handle query results ---
const handleQueryResults = async (replyToken: string, query: string, events: calendar_v3.Schema$Event[], hasMore: boolean) => {
  if (!events || events.length === 0) {
    const replyText = query
      ? `抱歉，找不到與「${query}」相關的未來活動。`
      : `太好了，這個時段目前沒有安排活動！`;
    return lineClient.replyMessage(replyToken, {
      type: 'text',
      text: replyText
    });
  }

  // 建立日曆 ID 到日曆名稱的映射以便查詢
  const calendarChoices = await getCalendarChoicesForUser();
  const calendarNameMap = new Map<string, string>();
  calendarChoices.forEach(c => calendarNameMap.set(c.id!, c.summary!));

  const bubbles = await Promise.all(events.slice(0, 10).map(async event => {
    const calendarId = event.organizer?.email;
    const calendarName = calendarId ? calendarNameMap.get(calendarId) || calendarId : '未知日曆';
    const headerText = `日曆：${calendarName}`.substring(0, 100); // Flex header has limit
    return await createEventFlexBubble(event, headerText);
  }));

  const carouselMessage: FlexMessage = {
    type: 'flex',
    altText: `為您找到 ${events.length} 個活動`,
    contents: {
      type: 'carousel',
      contents: bubbles,
    },
  };

  let replyText = query
    ? `為您找到 ${events.length} 個與「${query}」相關的活動：`
    : `為您找到 ${events.length} 個活動：`;

  if (hasMore) {
    replyText += '\n\n還有更多結果。如果沒找到您要的活動，請提供更精確的日期或關鍵字。'
  }

  return lineClient.replyMessage(replyToken, [
    { type: 'text', text: replyText },
    carouselMessage
  ]);
};

// --- 5e. 處理標題回應 ---
const handleTitleResponse = async (replyToken: string, message: TextEventMessage, userId: string, currentState: ConversationState) => {
  const completeEvent = { ...currentState.event, title: message.text } as CalendarEvent;
  const chatId = currentState.chatId!;
  await clearConversationState(userId, chatId);
  return processCompleteEvent(replyToken, completeEvent, userId, chatId);
};

// --- 5f. 處理重複回應 ---
const handleRecurrenceResponse = async (replyToken: string, message: TextEventMessage, userId: string, currentState: ConversationState) => {
  const originalEvent = currentState.event as CalendarEvent;
  const chatId = currentState.chatId!;

  try {
    const baseRrule = Array.isArray(originalEvent.recurrence) ? originalEvent.recurrence[0] : originalEvent.recurrence || '';
    const recurrenceResult = await parseRecurrenceEndCondition(message.text, baseRrule as string, originalEvent.start);

    if (!recurrenceResult || 'error' in recurrenceResult) {
      currentState.timestamp = Date.now();
      await setConversationState(userId, currentState, chatId);
      return lineClient.replyMessage(replyToken, { type: 'text', text: `抱歉，我不太理解您的意思。請問您希望這個重複活動什麼時候結束？\n(例如: 直到年底、重複10次、或直到 2025/12/31)` });
    }

    // Update the event in the current state with the new recurrence
    const updatedEvent = { ...originalEvent, recurrence: recurrenceResult.updatedRrule };
    await setConversationState(userId, { ...currentState, event: updatedEvent, timestamp: Date.now() }, chatId); // Update state with new event

    // Now call processCompleteEvent to continue the flow, which includes calendar selection
    return processCompleteEvent(replyToken, updatedEvent, userId, chatId);
  } catch (error) {
    console.error('Error in handleRecurrenceResponse:', error);
    // It's safer to use pushMessage here as the replyToken might be invalid after a long async operation
    await lineClient.pushMessage(userId, { type: 'text', text: '抱歉，處理重複性活動時發生錯誤。' });
    await clearConversationState(userId, chatId);
    return null; // Explicitly return null after handling the error
  }
};

// --- 5g. 處理完整事件 (重構後) ---
const processCompleteEvent = async (replyToken: string, event: CalendarEvent, userId: string, chatId: string, fromImage: boolean = false) => {
  // 如果 recurrence 存在但不完整，先詢問結束條件
  if (event.recurrence && !event.recurrence.includes('COUNT') && !event.recurrence.includes('UNTIL')) {
    await setConversationState(userId, { step: 'awaiting_recurrence_end_condition', event, timestamp: Date.now() }, chatId);
    const reply: Message = { type: 'text', text: `好的，活動「${event.title}」是一個重複性活動，請問您希望它什麼時候結束？\n(例如: 直到年底、重複10次、或直到 2025/12/31)` };
    return fromImage ? lineClient.pushMessage(userId, reply) : lineClient.replyMessage(replyToken, reply);
  }

  const calendarChoices = await getCalendarChoicesForUser();
  // 新流程：如果有多個日曆，先讓使用者選擇
  if (calendarChoices.length > 1) {
    await setConversationState(userId, { step: 'awaiting_calendar_choice', event, timestamp: Date.now() }, chatId);
    const timeDetails = await formatEventTime(event);
    const timeInfo = timeDetails.primary; // Use only the primary, more concise time info for the prompt

    const actions = calendarChoices.map((choice: CalendarChoice) => ({
      type: 'postback' as const,
      label: choice.summary.substring(0, 20),
      data: new URLSearchParams({ action: 'create_after_choice', calendarId: choice.id! }).toString(),
    }));

    const templateText = `時間：${timeInfo}\n新增至哪個日曆？`;
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

  // 單一日曆流程：直接檢查衝突並建立
  const singleCalendarId = calendarChoices[0]?.id || 'primary';
  const conflictingEvents = await findEventsInTimeRange(singleCalendarId, event.start, event.end, event.title);

  const actualConflicts = conflictingEvents.filter(
    (e) => !(e.summary === event.title && new Date(e.start?.dateTime || '').getTime() === new Date(event.start).getTime())
  );

  if (actualConflicts.length > 0) {
    await setConversationState(userId, { step: 'awaiting_conflict_confirmation', event, calendarId: singleCalendarId, timestamp: Date.now() }, chatId);

    const hardcodedText = `您預計新增的活動「${event.title}」與現有活動時間重疊。是否仍要建立？`;
    const template: TemplateMessage = {
      type: 'template',
      altText: '時間衝突警告',
      template: {
        type: 'buttons',
        title: '⚠️ 時間衝突',
        text: hardcodedText,
        actions: [
          { type: 'postback', label: '仍要建立', data: 'action=force_create' },
          { type: 'postback', label: '取消', data: 'action=cancel' },
        ],
      },
    };
    // 修正：改用 replyMessage 以確保回覆到正確的聊天室
    return lineClient.replyMessage(replyToken, template);
  }

  // 沒有衝突，直接建立
  try {
    const createdEvent = await createCalendarEvent(event, singleCalendarId);
    await clearConversationState(userId, chatId);

    const allCalendars = await getCalendarChoicesForUser();
    const calendarName = allCalendars.find(c => c.id === singleCalendarId)?.summary || singleCalendarId;

    // Combine original data with created event data for a complete view
    const displayEvent = {
      ...createdEvent,
      summary: event.title, // Ensure original title is used
      location: event.location,
      description: event.description,
    };

    const flexBubble = await createEventFlexBubble(displayEvent, `✅ 已新增至「${calendarName}」`);
    const confirmationMessage: FlexMessage = {
      type: 'flex',
      altText: `活動已新增：${event.title}`.substring(0, 400),
      contents: flexBubble,
    };

    return fromImage
      ? lineClient.pushMessage(userId, confirmationMessage)
      : lineClient.replyMessage(replyToken, confirmationMessage);

  } catch (error) {
    return handleCreateError(error, userId, lineClient);
  }
};

// --- 6. Postback 事件處理器 ---
const handlePostbackEvent = async (event: PostbackEvent) => {
  const { replyToken, postback, source } = event;
  const userId = source.userId;
  if (!userId) return Promise.resolve(null);

  const chatId = getChatId(event);

  console.log(`Handling postback: ${postback.data} in chat ${chatId}`);
  const params = new URLSearchParams(postback.data);
  const action = params.get('action');
  const currentState = await getConversationState(userId, chatId);

  if (action === 'cancel') {
    await clearConversationState(userId, chatId);
    return lineClient.replyMessage(replyToken, { type: 'text', text: '好的，操作已取消。' });
  }

  if (action === 'create_after_choice') {
    if (!currentState || !currentState.event || currentState.step !== 'awaiting_calendar_choice') {
      return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，您的請求已逾時或無效，請重新操作。' });
    }

    const eventToCreate = currentState.event as CalendarEvent;
    const calendarId = params.get('calendarId');

    if (!calendarId) {
      return lineClient.replyMessage(replyToken, { type: 'text', text: '錯誤：找不到日曆資訊，請重新操作。' });
    }

    const conflictingEvents = await findEventsInTimeRange(calendarId, eventToCreate.start!, eventToCreate.end!, eventToCreate.title!);
    const actualConflicts = conflictingEvents.filter(
      (e) => !(e.summary === eventToCreate.title && new Date(e.start?.dateTime || '').getTime() === new Date(eventToCreate.start!).getTime())
    );

    if (actualConflicts.length > 0) {
      await setConversationState(userId, { step: 'awaiting_conflict_confirmation', event: eventToCreate, calendarId: calendarId, timestamp: Date.now() }, chatId);

      const hardcodedText = `您預計新增的活動「${eventToCreate.title}」與現有活動時間重疊。是否仍要建立？`;
      const template: TemplateMessage = {
        type: 'template',
        altText: '時間衝突警告',
        template: {
          type: 'buttons',
          title: '⚠️ 時間衝突',
          text: hardcodedText,
          actions: [
            { type: 'postback', label: '仍要建立', data: 'action=force_create' },
            { type: 'postback', label: '取消', data: 'action=cancel' },
          ],
        },
      };
      return lineClient.replyMessage(replyToken, template);
    }

    try {
      const createdEvent = await createCalendarEvent(eventToCreate, calendarId);
      await clearConversationState(userId, chatId);

      const allCalendars = await getCalendarChoicesForUser();
      const calendarName = allCalendars.find(c => c.id === calendarId)?.summary || calendarId;

      const displayEvent = { ...createdEvent, summary: eventToCreate.title, location: eventToCreate.location, description: eventToCreate.description };
      const flexBubble = await createEventFlexBubble(displayEvent, `✅ 已新增至「${calendarName}」`);
      const confirmationMessage: FlexMessage = {
        type: 'flex',
        altText: `活動已新增：${eventToCreate.title}`.substring(0, 400),
        contents: flexBubble,
      };
      return lineClient.replyMessage(replyToken, confirmationMessage);

    } catch (error) {
      await clearConversationState(userId, chatId);
      return handleCreateError(error, userId, lineClient);
    }
  }

  if (action === 'delete') {
    const eventId = params.get('eventId');
    const calendarId = params.get('calendarId');
    if (!eventId || !calendarId) {
      return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，找不到要刪除的活動資訊。' });
    }

    try {
      const eventToDelete = await calendar.events.get({ calendarId, eventId });
      const eventTitle = eventToDelete.data.summary || '此活動';

      const calendarChoices = await getCalendarChoicesForUser();
      const calendarNameMap = new Map<string, string>();
      calendarChoices.forEach(c => calendarNameMap.set(c.id!, c.summary!));
      const calendarName = calendarNameMap.get(calendarId) || calendarId;

      await setConversationState(userId, {
        step: 'awaiting_delete_confirmation',
        eventId: eventId,
        calendarId: calendarId,
        timestamp: Date.now(),
      }, chatId);

      const template: TemplateMessage = {
        type: 'template',
        altText: `確認刪除活動： ${eventTitle}`,
        template: {
          type: 'confirm',
          text: `您確定要從「${calendarName}」日曆中刪除「${eventTitle}」嗎？此操作無法復原。`,
          actions: [
            { type: 'postback', label: '確定刪除', data: 'action=confirm_delete' },
            { type: 'postback', label: '取消', data: 'action=cancel' },
          ],
        },
      };
      return lineClient.replyMessage(replyToken, template);
    } catch (error) {
      console.error(`Error fetching event for deletion confirmation: ${error}`);
      return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，找不到要刪除的活動資訊。' });
    }
  }

  if (action === 'confirm_delete') {
    if (!currentState || currentState.step !== 'awaiting_delete_confirmation' || !currentState.eventId || !currentState.calendarId) {
      return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，您的刪除請求已逾時或無效，請重新操作。' });
    }
    const { eventId, calendarId } = currentState;
    await clearConversationState(userId, chatId);

    try {
      await deleteEvent(eventId, calendarId);
      return lineClient.replyMessage(replyToken, { type: 'text', text: '活動已成功刪除。' });
    } catch (error) {
      console.error(`Error deleting event: ${error}`);
      return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，刪除活動時發生錯誤。' });
    }
  }

  if (action === 'modify') {
    const eventId = params.get('eventId');
    const calendarId = params.get('calendarId');
    if (!eventId || !calendarId) {
      return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，找不到要修改的活動資訊。' });
    }
    await setConversationState(userId, {
      step: 'awaiting_modification_details',
      eventId: eventId,
      calendarId: calendarId,
      timestamp: Date.now(),
    }, chatId);
    return lineClient.replyMessage(replyToken, { type: 'text', text: '好的，請問您想如何修改這個活動？\n(例如：標題改為「團隊午餐」、時間改到明天下午一點、地點在公司餐廳、加上備註「討論Q4規劃」)\n\n若不需要做修改，請輸入「取消」。' });
  }

  if (action === 'force_create') {
    if (!currentState || !currentState.event || currentState.step !== 'awaiting_conflict_confirmation' || !currentState.calendarId) {
      return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，您的請求已逾時或無效，請重新操作。' });
    }
    const { event: eventToCreate, calendarId } = currentState;
    await clearConversationState(userId, chatId);

    try {
      const createdEvent = await createCalendarEvent(eventToCreate as CalendarEvent, calendarId);
      const allCalendars = await getCalendarChoicesForUser();
      const calendarName = allCalendars.find(c => c.id === calendarId)?.summary || calendarId;

      const displayEvent = { ...createdEvent, summary: eventToCreate.title, location: eventToCreate.location, description: eventToCreate.description };
      const flexBubble = await createEventFlexBubble(displayEvent, `✅ 已新增至「${calendarName}」`);
      const confirmationMessage: FlexMessage = {
        type: 'flex',
        altText: `活動已新增：${eventToCreate.title}`.substring(0, 400),
        contents: flexBubble,
      };
      return lineClient.replyMessage(replyToken, confirmationMessage);
    } catch (error) {
      return handleCreateError(error, userId, lineClient);
    }
  }

  if (action === 'createAllShifts') {
    if (!currentState || !currentState.events || currentState.step !== 'awaiting_bulk_confirmation') {
      return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，您的批次新增請求已逾時或無效，請重新上傳檔案。' });
    }
    const { events } = currentState;
    const calendarId = params.get('calendarId');

    if (!calendarId) {
      return lineClient.replyMessage(replyToken, { type: 'text', text: '錯誤：找不到日曆資訊，請重新操作。' });
    }

    await lineClient.replyMessage(replyToken, { type: 'text', text: `收到！正在為您處理 ${events.length} 個活動...` });

    try {
      let successCount = 0;
      let duplicateCount = 0;
      let failureCount = 0;
      const batchSize = 10;
      const delay = 500;
      let targetEvents: CalendarEvent[] = [];
      if (calendarId === 'all') {
        const calendarChoices = await getCalendarChoicesForUser();
        const allCalendarIds = calendarChoices.map(c => c.id);
        targetEvents = events.flatMap(event =>
          allCalendarIds.map(calId => ({ ...event, calendarId: calId! }))
        );
      } else {
        targetEvents = events.map(event => ({ ...event, calendarId }));
      }

      for (let i = 0; i < targetEvents.length; i += batchSize) {
        const batch = targetEvents.slice(i, i + batchSize);
        console.log(`Processing batch: ${i / batchSize + 1} / ${Math.ceil(targetEvents.length / batchSize)}`);

        const results = await Promise.allSettled(
          batch.map(event => createCalendarEvent(event, event.calendarId || 'primary'))
        );

        results.forEach(result => {
          if (result.status === 'fulfilled') {
            successCount++;
          } else {
            if (result.reason instanceof DuplicateEventError) {
              duplicateCount++;
            }
            else {
              failureCount++;
              console.error('Failed to create bulk event:', result.reason);
            }
          }
        });

        if (i + batchSize < targetEvents.length) {
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      const summaryMessage = `批次匯入完成：\n- 新增成功 ${successCount} 件\n- 已存在 ${duplicateCount} 件\n- 失敗 ${failureCount} 件`;
      await lineClient.pushMessage(chatId, { type: 'text', text: summaryMessage });
    } catch (error) {
      console.error("Error during batch createAllShifts:", error);
      await lineClient.pushMessage(chatId, { type: 'text', text: '批次新增過程中發生未預期的錯誤。' });
    } finally {
      await clearConversationState(userId, chatId);
    }

    return null;
  }

  return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，發生了未知的錯誤。' });
};

// --- 7. 輔助函式 ---
const handleEventUpdate = async (replyToken: string, message: TextEventMessage, userId: string, currentState: ConversationState) => {
  const { eventId, calendarId, chatId } = currentState;
  if (!eventId || !calendarId) {
    await clearConversationState(userId, chatId);
    return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，請求已逾時，找不到要修改的活動。' });
  }

  console.log(`Handling event update for eventId: ${eventId} in calendar: ${calendarId} with text: "${message.text}"`);
  const changes = await parseEventChanges(message.text);

  if ('error' in changes || Object.keys(changes).length === 0) {
    // If Gemini couldn't parse the update, ask again.
    return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，我不太理解您的修改指令，可以請您說得更清楚一點嗎？\n(例如：標題改為「團隊午餐」、時間改到明天下午一點、地點在公司餐廳、加上備註「討論Q4規劃」)\n\n若不需要做修改，請輸入「取消」。' });
  }

  await clearConversationState(userId, chatId);
  try {
    // 建立一個 patch 物件，將 title 對應到 summary
    const eventPatch: calendar_v3.Schema$Event = {};
    const { title, start, end, location, description } = changes;
    if (title) eventPatch.summary = title;
    if (start) {
      if (start.includes('T')) {
        eventPatch.start = { dateTime: start, date: null, timeZone: 'Asia/Taipei' };
      } else {
        eventPatch.start = { date: start, dateTime: null };
      }
    }
    if (end) {
      if (end.includes('T')) {
        eventPatch.end = { dateTime: end, date: null, timeZone: 'Asia/Taipei' };
      } else {
        eventPatch.end = { date: end, dateTime: null };
      }
    }
    if (location) eventPatch.location = location;
    if (description) eventPatch.description = description;

    const updatedEvent = await updateEvent(eventId, calendarId, eventPatch);

    const flexBubble = await createEventFlexBubble(updatedEvent, '✅ 活動已更新');
    const confirmationMessage: FlexMessage = {
      type: 'flex',
      altText: `活動已更新：${updatedEvent.summary || ''}`.substring(0, 400),
      contents: flexBubble,
    };
    return lineClient.replyMessage(replyToken, confirmationMessage);

  } catch (error) {
    console.error('Error updating event:', error);
    return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，更新活動時發生錯誤。' });
  }
};

// --- 本地開發 & Vercel 進入點 ---
let server: any;
if (require.main === module) {
  const port = process.env.PORT || 3000;
  server = app.listen(port, () => console.log(`[Local] Server is listening on http://localhost:${port}`));
}
export default app;
export { server, redis, handleEvent, handleTextMessage, handleFileMessage, handlePostbackEvent, handleImageMessage, handleRecurrenceResponse, handleTitleResponse, handleEventUpdate, processCompleteEvent, handleQueryResults, handleNewCommand };