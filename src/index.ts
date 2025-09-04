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
} from '@line/bot-sdk';
import { calendar_v3 } from 'googleapis';
import {
  classifyIntent,
  Intent,
  CalendarEvent,
  parseRecurrenceEndCondition,
  parseEventChanges,
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
import Redis from 'ioredis'; // Import Redis

// --- 1. 設定 ---
if (!process.env.LINE_CHANNEL_SECRET || !process.env.LINE_CHANNEL_ACCESS_TOKEN) {
  throw new Error('Missing LINE channel secret or access token');
}
const lineConfig: MiddlewareConfig = { channelSecret: process.env.LINE_CHANNEL_SECRET };
const clientConfig: ClientConfig = { channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN };
const lineClient = new Client(clientConfig);
const userWhitelist: string[] = (process.env.USER_WHITELIST || '').split(',');

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
}

// 使用 Redis 儲存對話狀態
const redis = new Redis(process.env.REDIS_URL || 'redis://localhost:6379');

redis.on('error', (err) => {
  console.error('Redis Error:', err);
});

// 輔助函式：從 Redis 取得對話狀態
async function getConversationState(userId: string): Promise<ConversationState | undefined> {
  const stateJson = await redis.get(userId);
  return stateJson ? JSON.parse(stateJson) : undefined;
}

// 輔助函式：設定對話狀態到 Redis (設定 1 小時過期)
async function setConversationState(userId: string, state: ConversationState): Promise<void> {
  await redis.set(userId, JSON.stringify(state), 'EX', 3600);
}

// 輔助函式：從 Redis 清除對話狀態
async function clearConversationState(userId: string): Promise<void> {
  await redis.del(userId);
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

// --- 4. 主要事件路由 ---
const handleEvent = async (event: WebhookEvent) => {
  let userId: string; // 將 userId 宣告提升到這裡

  // 允許 'join' 事件直接通過，不進行使用者 ID 白名單檢查
  if (event.type === 'join') {
    // 處理 join 事件，並向群組/聊天室發送訊息
    // 不需要在此處檢查使用者 ID
  } else {
    // 對於其他事件類型 (如 'message', 'postback')，檢查使用者 ID
    userId = event.source.userId!; // 在這裡賦值
    if (!userId || !userWhitelist.includes(userId)) {
      console.log(`Rejected event from non-whitelisted user: ${userId}`);
      return null;
    }
  }

  // 通用狀態超時檢查
  const currentState = await getConversationState(userId!);
  if (currentState && (Date.now() - currentState.timestamp > 10 * 60 * 1000)) { // 10 分鐘超時
    console.log(`State for user ${userId!} has expired.`);
    await clearConversationState(userId!);
  }

  switch (event.type) {
    case 'message':
      if (event.message.type === 'file') {
        return handleFileMessage(event.replyToken, event.message as FileEventMessage, userId!);
      } else if (event.message.type === 'image') {
        return handleImageMessage(event.replyToken, event.message, userId!);
      } else if (event.message.type === 'text') {
        return handleTextMessage(event.replyToken, event.message, userId!);
      }
      break;
    case 'postback':
      return handlePostbackEvent(event);
    // --- 新增：處理加入群組/聊天室事件 ---
    case 'join':
      const welcomeMessage = `哈囉！我是您的 AI 日曆助理。用自然語言輕鬆管理 Google 日曆！

您可以這樣對我說：

🗓️ 新增活動：
*   \n明天早上9點開會\n*   \n9月15號下午三點跟John面試\n*   \n每週一早上9點的站立會議\n (會追問結束條件)

🔍 查詢活動：
*   \n明天有什麼事\n*   \n下週有什麼活動\n*   \n我什麼時候要跟John面試\n
✏️ 修改活動：
*   \n把明天下午3點的會議改到下午4點\n
🗑️ 刪除活動：
*   \n取消明天下午3點的會議\n
📊 班表建立 (CSV 專屬！)：
*   想整理班表？請先說\n幫我建立[人名]的班表\n，再傳 **CSV 格式**檔案。我的火眼金睛只認 CSV，圖片還在學！

請盡量使用自然語言描述您的需求，我會盡力理解！`;

      let targetId: string | undefined;
      if (event.source.type === 'group') {
        targetId = event.source.groupId;
      } else if (event.source.type === 'room') {
        targetId = event.source.roomId;
      }

      if (targetId) {
        console.log(`Bot joined ${event.source.type}: ${targetId}. Sending welcome message.`);
        await lineClient.pushMessage(targetId, { type: 'text', text: welcomeMessage });
      } else {
        console.log('Bot joined an unknown source type or missing ID.');
      }
      return null;
    // --- 結束：處理加入群組/聊天室事件 ---
    default:
      console.log(`Unhandled event type: ${event.type}`);
      return null;
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

const handleFileMessage = async (replyToken: string, message: FileEventMessage, userId: string) => {
  const currentState = await getConversationState(userId);

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

    await clearConversationState(userId);

    if (events.length === 0) {
      return lineClient.replyMessage(replyToken, { type: 'text', text: `在您上傳的 CSV 檔案中，找不到「${personName}」的任何班次，或格式不正確。` });
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

    await setConversationState(userId, { step: 'awaiting_bulk_confirmation', events, timestamp: Date.now() });
    const calendarChoices = await getCalendarChoicesForUser();
    let confirmationTemplate: TemplateMessage;
    if (calendarChoices.length <= 1) {
      const summaryText = `您要將這 ${events.length} 個活動一次全部新增至您的 Google 日曆嗎？`;
      confirmationTemplate = {
        type: 'template',
        altText: '需要您確認批次新增活動',
        template: {
          type: 'buttons',
          title: `為 ${personName} 批次新增活動 (CSV)`,
          text: summaryText,
          actions: [
            { type: 'postback', label: '全部新增', data: `action=createAllShifts&calendarId=${calendarChoices[0]?.id || 'primary'}` },
            { type: 'postback', label: '取消', data: 'action=cancel' },
          ],
        },
      };
    } else {
      // 按鈕樣板最多支援 4 個動作。
      // 我們將顯示最多 3 個日曆，並始終包含「取消」按鈕。
      const maxCalendarActions = 3;
      const actions: Action[] = calendarChoices.slice(0, maxCalendarActions).map((choice: CalendarChoice) => ({
        type: 'postback' as const,
        label: choice.summary.substring(0, 20), // 標籤有 20 個字元的限制
        data: `action=createAllShifts&calendarId=${choice.id}`,
      }));

      actions.push({ type: 'postback', label: '取消', data: 'action=cancel' });

      confirmationTemplate = {
        type: 'template',
        altText: '請選擇要新增的日曆',
        template: {
          type: 'buttons',
          title: `為 ${personName} 批次新增活動 (CSV)`,
          text: `偵測到您有多個日曆，請問您要將這 ${events.length} 個活動新增至哪個日曆？`,
          actions: actions,
        },
      };
    }

    return lineClient.replyMessage(replyToken, [summaryMessage, confirmationTemplate]);

  } catch (error) {
    console.error('Error processing uploaded CSV file:', error);
    await clearConversationState(userId); // 發生錯誤時清除狀態
    return lineClient.replyMessage(replyToken, { type: 'text', text: '處理您上傳的 CSV 檔案時發生錯誤。' });
  }
};

export const parseCsvToEvents = (csvContent: string, personName: string): CalendarEvent[] => {
  // 如果存在 BOM 字元，則將其移除
  if (csvContent.charCodeAt(0) === 0xFEFF) {
    csvContent = csvContent.slice(1);
  }

  let lines = csvContent.trim().split(/\r?\n/); // 處理 \n 和 \r\n 兩種換行符
  // 尋找實際的標頭列，假設它以「姓名」開頭
  const headerRowIndex = lines.findIndex(line => line.startsWith('"姓名"') || line.startsWith('姓名'));
  
  if (headerRowIndex === -1) {
    console.log('CSV PARSE DEBUG: Header row starting with "姓名" not found.');
    return [];
  }

  // 丟棄標頭列之前的任何行
  lines = lines.slice(headerRowIndex);

  const events: CalendarEvent[] = [];
  if (lines.length < 2) return []; // 資料不足
  const header = lines[0].split(',').map(h => h.replace(/"/g, '').trim());
  const dateHeaders = header.slice(1);

  const normalizedPersonName = personName.normalize('NFC');

  const personRow = lines.slice(1).find(line => {
    const firstCell = line.split(',')[0];
    if (!firstCell) return false;
    // 標準化、移除引號並修剪以確保穩健的比較
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
  const shiftData = rowData.slice(1);

  const year = new Date().getFullYear(); // 假設為當前年份
  dateHeaders.forEach((dateStr, index) => {
    const shift = shiftData[index];
    if (!shift || shift === '假' || shift === '休') return;

    const [month, day] = dateStr.split('/').map(Number);

    let startHour: string, startMinute: string, endHour: string, endMinute: string;
    let eventTitle: string;

    // 將描述性班次對應到時間範圍
    switch (shift) {
      case '早班':
        startHour = '09'; startMinute = '00'; endHour = '17'; endMinute = '00';
        eventTitle = `${personName} ${shift}`;
        break;
      case '晚班':
        startHour = '14'; startMinute = '00'; endHour = '22'; endMinute = '00';
        eventTitle = `${personName} ${shift}`;
        break;
      case '早接菜':
        startHour = '07'; startMinute = '00'; endHour = '15'; endMinute = '00';
        eventTitle = `${personName} ${shift}`;
        break;
      // 根據需要為其他描述性班次新增更多案例
      default:
        // 如果不是描述性班次，請嘗試匹配時間模式
        const timeMatch = shift.match(/(\d{1,2})(\d{2})?-(\d{1,2})(\d{2})?/);
        if (!timeMatch) return; // 如果不匹配，則跳過此班次
        startHour = timeMatch[1].padStart(2, '0');
        startMinute = timeMatch[2] || '00';
        endHour = timeMatch[3].padStart(2, '0');
        endMinute = timeMatch[4] || '00';
        
        const startHourInt = parseInt(startHour, 10);
        if (startHourInt < 12) {
          eventTitle = `${personName} 早班`;
        } else {
          eventTitle = `${personName} 晚班`;
        }
        break;
    }

    const startDate = `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    events.push({
      title: eventTitle,
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

// --- 5b. 文字訊息處理器 (新流程) ---
const handleTextMessage = async (replyToken: string, message: TextEventMessage, userId: string) => {
  const currentState = await getConversationState(userId);

  // --- 新增班表分析觸發器 ---
  const nameMatch = message.text.match(/幫(?:「|『)?(.+?)(?:」|『)?建立班表/);
  if (nameMatch) {
    const personName = nameMatch[1].trim();
    console.log(`Request to create schedule for "${personName}". Awaiting CSV file.`);
    await setConversationState(userId, {
      step: 'awaiting_csv_upload',
      personName: personName, 
      timestamp: Date.now() 
    });
    return lineClient.replyMessage(replyToken, {
      type: 'text', 
      text: `好的，請現在傳送您要為「${personName}」分析的班表 CSV 檔案。` 
    });
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
  return handleNewCommand(replyToken, message, userId);
};


// --- 5d. 處理新文字指令 ---
const handleNewCommand = async (replyToken: string, message: TextEventMessage, userId: string) => {
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
        await setConversationState(userId, { step: 'awaiting_event_title', event, timestamp: Date.now() });
        const timeDetails = new Date(event.start).toLocaleString('zh-TW', { dateStyle: 'short', timeStyle: 'short', hour12: false, timeZone: 'Asia/Taipei' });
        return lineClient.replyMessage(replyToken, { type: 'text', text: `好的，請問「${timeDetails}」要安排什麼活動呢？` });
      }
      return processCompleteEvent(replyToken, event as CalendarEvent, userId);

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
      
      // 1. Find the event to update
      const calendarChoicesUpdate = await getCalendarChoicesForUser();
      const allCalendarIdsUpdate = calendarChoicesUpdate.map(c => c.id!);
      
      const updateSearchPromises = allCalendarIdsUpdate.map(calId => 
        searchEvents(calId, intent.timeMin, intent.timeMax, intent.query)
      );
      const eventsToUpdate = (await Promise.all(updateSearchPromises)).flatMap(r => r.events);

      // 2. Handle different scenarios
      if (eventsToUpdate.length === 0) {
        return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，找不到您想修改的活動。' });
      }

      if (eventsToUpdate.length > 1) {
        return lineClient.replyMessage(replyToken, { type: 'text', text: '我找到了多個符合條件的活動，請您先用「查詢」功能找到想修改的活動，然後再點擊該活動下方的「修改」按鈕。' });
      }

      // 3. Proceed with the update if exactly one event is found
      const eventToUpdate = eventsToUpdate[0];
      const eventId = eventToUpdate.id!;
      const calendarId = eventToUpdate.organizer!.email!;
      
      try {
        const eventPatch: calendar_v3.Schema$Event = {};
        const changes = intent.changes;

        if (changes.title) {
          eventPatch.summary = changes.title;
        }
        if (changes.start) {
          eventPatch.start = { dateTime: changes.start, timeZone: 'Asia/Taipei' };
        }
        if (changes.end) {
          eventPatch.end = { dateTime: changes.end, timeZone: 'Asia/Taipei' };
        }
        
        const updatedEvent = await updateEvent(eventId, calendarId, eventPatch);

        const confirmationMessage: TemplateMessage = {
          type: 'template',
          altText: '活動已更新',
          template: {
            type: 'buttons',
            title: `✅ 活動已更新`,
            text: `「${updatedEvent.summary}」已更新。`,
            actions: [{
              type: 'uri',
              label: '在 Google 日曆中查看',
              uri: updatedEvent.htmlLink!
            }]
          }
        };
        return lineClient.replyMessage(replyToken, confirmationMessage);

      } catch (error) {
        console.error('Error updating event directly:', error);
        return lineClient.pushMessage(userId, { type: 'text', text: '抱歉，更新活動時發生錯誤。' });
      }

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
        });

        const template: TemplateMessage = {
          type: 'template',
          altText: `確認刪除活動： ${event.summary}`,
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

      // If multiple events are found, ask user to be more specific or use the query tool.
      return lineClient.replyMessage(replyToken, { type: 'text', text: '我找到了多個符合條件的活動，請您先用「查詢」功能找到想刪除的活動，然後再點擊該活動下方的「刪除」按鈕。' });

    case 'create_schedule':
      // This is handled by a separate trigger in handleTextMessage, but we keep it here for completeness.
      console.log(`Request to create schedule for "${intent.personName}". Awaiting CSV file.`);
      await setConversationState(userId, {
        step: 'awaiting_csv_upload',
        personName: intent.personName,
        timestamp: Date.now()
      });
      return lineClient.replyMessage(replyToken, {
        type: 'text',
        text: `好的，請現在傳送您要為「${intent.personName}」分析的班表 CSV 檔案。`
      });

    case 'incomplete':
    case 'unknown':
      console.log(`Intent was incomplete or unknown for text: "${intent.originalText}"`);
      // We can choose to either ignore it or ask for clarification.
      // For now, we'll just log it and do nothing, to avoid being too noisy.
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

  const columns = events.slice(0, 10).map(event => {
    const title = event.summary || '無標題';
    const timeInfo = formatEventTime({
      start: event.start?.dateTime || event.start?.date || undefined,
      end: event.end?.dateTime || event.end?.date || undefined,
      allDay: !!event.start?.date,
    });

    const calendarId = event.organizer?.email;
    const calendarName = calendarId ? calendarNameMap.get(calendarId) || calendarId : '未知日曆';

    const textWithCalendar = `日曆：${calendarName}\n${timeInfo}`;
    const actions: Action[] = [];
    if (event.id && calendarId) {
        actions.push({ type: 'postback', label: '修改活動', data: `action=modify&eventId=${event.id}&calendarId=${calendarId}` });
        actions.push({ type: 'postback', label: '刪除活動', data: `action=delete&eventId=${event.id}&calendarId=${calendarId}` });
    }

    if (event.htmlLink) {
        actions.push({ type: 'uri', label: '在日曆中查看', uri: event.htmlLink });
    }

    return {
      title: title.substring(0, 40),
      text: textWithCalendar.substring(0, 60),
      actions: actions,
    };
  });

  const carouselTemplate: TemplateMessage = {
    type: 'template',
    altText: `為您找到 ${events.length} 個活動`,
    template: {
      type: 'carousel',
      columns: columns,
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
    carouselTemplate
  ]);
};

// --- 5e. 處理標題回應 ---
const handleTitleResponse = async (replyToken: string, message: TextEventMessage, userId: string, currentState: ConversationState) => {
  const completeEvent = { ...currentState.event, title: message.text } as CalendarEvent;
  await clearConversationState(userId);
  return processCompleteEvent(replyToken, completeEvent, userId);
};

// --- 5f. 處理重複回應 ---
const handleRecurrenceResponse = async (replyToken: string, message: TextEventMessage, userId: string, currentState: ConversationState) => {
  const originalEvent = currentState.event as CalendarEvent;
  const recurrenceResult = await parseRecurrenceEndCondition(message.text, originalEvent.recurrence || '', originalEvent.start);

  if ('error' in recurrenceResult) {
    currentState.timestamp = Date.now();
    await setConversationState(userId, currentState);
    return lineClient.replyMessage(replyToken, { type: 'text', text: `抱歉，我不太理解您的意思。請問您希望這個重複活動什麼時候結束？\n(例如: 直到年底、重複10次、或直到 2025/12/31)` });
  }

  try {
    // Update the event in the current state with the new recurrence
    const updatedEvent = { ...originalEvent, recurrence: recurrenceResult.updatedRrule };
    await setConversationState(userId, { ...currentState, event: updatedEvent, timestamp: Date.now() }); // Update state with new event

    // Now call processCompleteEvent to continue the flow, which includes calendar selection
    return processCompleteEvent(replyToken, updatedEvent, userId);
  } catch (error) {
    await clearConversationState(userId);
    return handleCreateError(error, userId);
  }
};

// --- 5g. 處理完整事件 (重構後) ---
const processCompleteEvent = async (replyToken: string, event: CalendarEvent, userId: string, fromImage: boolean = false) => {
  // 如果 recurrence 存在但不完整，先詢問結束條件
  if (event.recurrence && !event.recurrence.includes('COUNT') && !event.recurrence.includes('UNTIL')) {
    await setConversationState(userId, { step: 'awaiting_recurrence_end_condition', event, timestamp: Date.now() });
    const reply: Message = { type: 'text', text: `好的，活動「${event.title}」是一個重複性活動，請問您希望它什麼時候結束？\n(例如: 直到年底、重複10次、或直到 2025/12/31)` };
    return fromImage ? lineClient.pushMessage(userId, reply) : lineClient.replyMessage(replyToken, reply);
  }

  const calendarChoices = await getCalendarChoicesForUser();
  // 新流程：如果有多個日曆，先讓使用者選擇
  if (calendarChoices.length > 1) {
    await setConversationState(userId, { step: 'awaiting_calendar_choice', event, timestamp: Date.now() });
    const timeInfo = formatEventTime(event);
    const actions = calendarChoices.map((choice: CalendarChoice) => ({
      type: 'postback' as const,
      label: choice.summary.substring(0, 20),
      data: new URLSearchParams({ action: 'create_after_choice', calendarId: choice.id! }).toString(),
    }));

    const templateText = `時間：${timeInfo}\n請問您要將這個活動新增至哪個日曆？`;
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
  const conflictingEvents = await findEventsInTimeRange(event.start, event.end, singleCalendarId);

  const actualConflicts = conflictingEvents.filter(
    (e) => !(e.summary === event.title && new Date(e.start?.dateTime || '').getTime() === new Date(event.start).getTime())
  );

  if (actualConflicts.length > 0) {
    await setConversationState(userId, { step: 'awaiting_conflict_confirmation', event, calendarId: singleCalendarId, timestamp: Date.now() });
    
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
    // 因為衝突檢查延遲高，使用 pushMessage
    return lineClient.pushMessage(userId, template);
  }

  // 沒有衝突，直接建立
  try {
    const reply: Message = { type: 'text', text: '收到指令，正在為您建立活動...' };
    if (!fromImage) await lineClient.replyMessage(replyToken, reply);
    const createdEvent = await createCalendarEvent(event, singleCalendarId);
    await clearConversationState(userId); // Add this line
    return sendCreationConfirmation(userId, event, createdEvent);
  } catch (error) {
    return handleCreateError(error, userId);
  }
};

// --- 6. Postback 事件處理器 ---
const handlePostbackEvent = async (event: PostbackEvent) => {
  const { replyToken, postback, source } = event;
  const userId = source.userId;
  if (!userId) return Promise.resolve(null);

  console.log(`Handling postback: ${postback.data}`);
  const params = new URLSearchParams(postback.data);
  const action = params.get('action');
  const currentState = await getConversationState(userId);

  if (action === 'cancel') {
    await clearConversationState(userId);
    return lineClient.replyMessage(replyToken, { type: 'text', text: '好的，操作已取消。' });
  }

  // 新：當使用者選擇日曆後
  if (action === 'create_after_choice') {
    if (!currentState || !currentState.event || currentState.step !== 'awaiting_calendar_choice') {
      return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，您的請求已逾時或無效，請重新操作。' });
    }
    
    const event = currentState.event as CalendarEvent;
    const calendarId = params.get('calendarId');

    if (!calendarId) {
      return lineClient.replyMessage(replyToken, { type: 'text', text: '錯誤：找不到日曆資訊，請重新操作。' });
    }

    // 在特定日曆上檢查衝突
    const conflictingEvents = await findEventsInTimeRange(event.start!, event.end!, calendarId);
    const actualConflicts = conflictingEvents.filter(
      (e) => !(e.summary === event.title && new Date(e.start?.dateTime || '').getTime() === new Date(event.start!).getTime())
    );

    if (actualConflicts.length > 0) {
      await setConversationState(userId, { step: 'awaiting_conflict_confirmation', event, calendarId: calendarId, timestamp: Date.now() });
      
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
      await lineClient.replyMessage(replyToken, {type: 'text', text: '好的，正在檢查時間衝突...'})
      return lineClient.pushMessage(userId, template);
    }

    // 沒有衝突，直接建立
    try {
      const createdEvent = await createCalendarEvent(event, calendarId);
      await clearConversationState(userId);

      // 修正：在此處直接使用 replyToken 回覆最終的確認訊息
      const timeInfo = formatEventTime(event);
      const allCalendars = await getCalendarChoicesForUser();
      const calendarName = allCalendars.find(c => c.id === calendarId)?.summary || calendarId;

      const confirmationTemplate: TemplateMessage = {
        type: 'template',
        altText: `活動「${event.title}」已新增`,
        template: {
          type: 'buttons',
          title: `✅ ${event.title.substring(0, 40)}`,
          text: `時間：${timeInfo}\n已新增至「${calendarName}」日曆`.substring(0, 160),
          actions: [{
            type: 'uri',
            label: '在 Google 日曆中查看',
            uri: createdEvent.htmlLink!
          }]
        }
      };
      return lineClient.replyMessage(replyToken, confirmationTemplate);

    } catch (error) {
      await clearConversationState(userId);
      return handleCreateError(error, userId);
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

      // 取得日曆名稱以便顯示在確認訊息中
      const calendarChoices = await getCalendarChoicesForUser();
      const calendarNameMap = new Map<string, string>();
      calendarChoices.forEach(c => calendarNameMap.set(c.id!, c.summary!));
      const calendarName = calendarNameMap.get(calendarId) || calendarId;

      await setConversationState(userId, {
        step: 'awaiting_delete_confirmation',
        eventId: eventId,
        calendarId: calendarId,
        timestamp: Date.now(),
      });

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
    await clearConversationState(userId);

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
    });
    return lineClient.replyMessage(replyToken, { type: 'text', text: '好的，請問您想如何修改這個活動？\n(例如：標題改為「團隊午餐」、時間改到「明天下午一點」)' });
  }

  if (action === 'force_create') {
    if (!currentState || !currentState.event || currentState.step !== 'awaiting_conflict_confirmation' || !currentState.calendarId) {
      return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，您的請求已逾時或無效，請重新操作。' });
    }
    const { event: eventToCreate, calendarId } = currentState;
    await clearConversationState(userId);
    
    await lineClient.replyMessage(replyToken, { type: 'text', text: '好的，已忽略衝突，正在為您建立活動...' });

    try {
        const createdEvent = await createCalendarEvent(eventToCreate as CalendarEvent, calendarId);
        await clearConversationState(userId); // Add this line
        return sendCreationConfirmation(userId, eventToCreate as CalendarEvent, createdEvent);
    } catch (error) {
        return handleCreateError(error, userId);
    }
  }

  // 處理 CSV 批次建立與分批處理
  if (action === 'createAllShifts') {
    if (!currentState || !currentState.events || currentState.step !== 'awaiting_bulk_confirmation') {
      return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，您的批次新增請求已逾時或無效，請重新上傳檔案。' });
    }
    const { events } = currentState;
    const calendarId = params.get('calendarId');

    if (!calendarId) {
        return lineClient.replyMessage(replyToken, { type: 'text', text: '錯誤：找不到日曆資訊，請重新操作。' });
    }

    // 立即回覆使用者，避免 LINE Webhook 逾時
    await lineClient.replyMessage(replyToken, { type: 'text', text: `收到！正在為您處理 ${events.length} 個活動...` });

    // 在背景中處理事件建立，並確保 Serverless 函數會等待此程序完成
    try {
      let successCount = 0;
      let duplicateCount = 0;
      let failureCount = 0;
      const batchSize = 10;
      const delay = 500; // 每批之間延遲 500 毫秒
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
            } else {
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
      await lineClient.pushMessage(userId, { type: 'text', text: summaryMessage });
    } catch (error) {
        console.error("Error during batch createAllShifts:", error);
        await lineClient.pushMessage(userId, { type: 'text', text: '批次新增過程中發生未預期的錯誤。' });
    } finally {
      // 無論成功或失敗，最後都清除對話狀態
      await clearConversationState(userId);
    }

    return null; // Webhook 應回傳 200 OK，實際的結果是透過 pushMessage 傳送
  }

  return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，發生了未知的錯誤。' });
};

// --- 7. 輔助函式 ---
const handleEventUpdate = async (replyToken: string, message: TextEventMessage, userId: string, currentState: ConversationState) => {
  const { eventId, calendarId } = currentState;
  if (!eventId || !calendarId) {
    await clearConversationState(userId);
    return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，請求已逾時，找不到要修改的活動。' });
  }

  console.log(`Handling event update for eventId: ${eventId} in calendar: ${calendarId} with text: "${message.text}"`);
  const changes = await parseEventChanges(message.text);

  if ('error' in changes || (!changes.title && !changes.start)) {
    // If Gemini couldn't parse the update, ask again.
    return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，我不太理解您的修改指令，可以請您說得更清楚一點嗎？\n(例如：時間改到明天下午三點，標題改為「團隊午餐」)' });
  }

  await clearConversationState(userId);
  try {
    const eventPatch: calendar_v3.Schema$Event = {};

    if (changes.title) {
      eventPatch.summary = changes.title;
    }
    if (changes.start) {
      eventPatch.start = { dateTime: changes.start, timeZone: 'Asia/Taipei' };
    }
    if (changes.end) {
      eventPatch.end = { dateTime: changes.end, timeZone: 'Asia/Taipei' };
    }
    
    const updatedEvent = await updateEvent(eventId, calendarId, eventPatch);

    const confirmationMessage: TemplateMessage = {
      type: 'template',
      altText: '活動已更新',
      template: {
        type: 'buttons',
        title: `✅ 活動已更新`,
        text: `「${updatedEvent.summary}」已更新。`,
        actions: [{
          type: 'uri',
          label: '在 Google 日曆中查看',
          uri: updatedEvent.htmlLink!
        }]
      }
    };
    return lineClient.replyMessage(replyToken, confirmationMessage);

  } catch (error) {
    console.error('Error updating event:', error);
    return lineClient.replyMessage(replyToken, { type: 'text', text: '抱歉，更新活動時發生錯誤。' });
  }
};

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
  }
  else {
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
  allCalendars.forEach(c => calendarNameMap.set(c.id!, c.summary!));

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
      calendarId: cal.id!,
      q: event.title,
      timeMin: event.start,
      timeMax: event.end,
      singleEvents: true,
    }).then((res: { data: calendar_v3.Schema$Events }) => ({
      ...res, 
      calName: cal.summary! // Pass calendar name through
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
            break; // 在此日曆中找到，移至下一個
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

  // 超過 1 個，使用輪播
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
  return lineClient.pushMessage(userId, { type: 'text', text: '抱歉，新增日曆事件時發生錯誤。' });
};

// --- 本地開發 & Vercel 進入點 ---
let server: any;
if (require.main === module) {
  const port = process.env.PORT || 3000;
  server = app.listen(port, () => console.log(`[Local] Server is listening on http://localhost:${port}`));
}
export default app;
export { server, redis, handleEvent, handleTextMessage, handleFileMessage, handlePostbackEvent, handleImageMessage, handleRecurrenceResponse, handleTitleResponse, handleEventUpdate, processCompleteEvent, formatEventTime, sendCreationConfirmation, handleCreateError, handleQueryResults, handleNewCommand };
