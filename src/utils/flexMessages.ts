
import { FlexBubble, FlexMessage } from '@line/bot-sdk';
import { calendar_v3 } from 'googleapis';
import { CalendarEvent } from '../services/geminiService';
import { formatEventTime, FormattedTime, getConciseRecurrenceDescription } from './time';
import { getCalendarChoicesForUser } from '../services/googleCalendarService';

// --- 全新的 Flex Message 卡片產生器 ---
export const createEventFlexBubble = async (event: any, headerText: string): Promise<FlexBubble> => {
  const eventTitle = event.summary || '無標題';

  // Handle both string and object formats for start/end
  const getEventTime = (time: any): string | undefined => {
    if (typeof time === 'string') return time;
    if (typeof time === 'object' && time !== null) {
      return time.dateTime || time.date;
    }
    return undefined;
  };

  const timeDetails: FormattedTime = await formatEventTime({
    start: getEventTime(event.start),
    end: getEventTime(event.end),
    allDay: !!(event.start && event.start.date),
    recurrence: event.recurrence,
  });

  const bodyContents: any[] = [
    {
      type: 'text',
      text: eventTitle,
      weight: 'bold',
      size: 'xl',
      wrap: true,
    },
    {
      type: 'text',
      text: timeDetails.primary,
      size: 'md',
      color: '#666666',
      margin: 'md',
      wrap: true,
    },
  ];

  if (event.location) {
    bodyContents.push({
      type: 'separator',
      margin: 'xl',
    });
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      margin: 'lg',
      spacing: 'sm',
      contents: [
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: '地點',
              color: '#aaaaaa',
              size: 'sm',
              flex: 1,
            },
            {
              type: 'text',
              text: event.location,
              wrap: true,
              color: '#666666',
              size: 'sm',
              flex: 4,
            },
          ],
        },
      ],
    });
  }

  if (event.description) {
    bodyContents.push({
      type: 'separator',
      margin: 'xl',
    });
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      margin: 'lg',
      spacing: 'sm',
      contents: [
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: '備註',
              color: '#aaaaaa',
              size: 'sm',
              flex: 1,
            },
            {
              type: 'text',
              text: event.description,
              wrap: true,
              color: '#666666',
              size: 'sm',
              flex: 4,
            },
          ],
        },
      ],
    });
  }

  if (timeDetails.secondary) {
    bodyContents.push({
      type: 'separator',
      margin: 'xl',
    });
    bodyContents.push({
      type: 'box',
      layout: 'vertical',
      margin: 'lg',
      spacing: 'sm',
      contents: [
        {
          type: 'box',
          layout: 'baseline',
          spacing: 'sm',
          contents: [
            {
              type: 'text',
              text: '重複',
              color: '#aaaaaa',
              size: 'sm',
              flex: 1,
            },
            {
              type: 'text',
              text: timeDetails.secondary,
              wrap: true,
              color: '#666666',
              size: 'sm',
              flex: 4,
            },
          ],
        },
      ],
    });
  }

  const footerActions: any[] = [];
  if (event.htmlLink) {
    footerActions.push({
      type: 'uri',
      label: '在 Google 日曆中查看',
      uri: event.htmlLink,
    });
  }

  // Add Modify and Delete buttons
  const eventId = event.id;
  const calendarId = event.organizer?.email;

  if (eventId && calendarId) {
    footerActions.push({
      type: 'postback',
      label: '修改活動',
      data: `action=modify&eventId=${eventId}&calendarId=${calendarId}`,
    });
    footerActions.push({
      type: 'postback',
      label: '刪除活動',
      data: `action=delete&eventId=${eventId}&calendarId=${calendarId}`,
    });
  }


  return {
    type: 'bubble',
    header: {
      type: 'box',
      layout: 'vertical',
      contents: [
        {
          type: 'text',
          text: headerText,
          weight: 'bold',
          color: '#1DB446',
          size: 'sm',
        },
      ],
    },
    body: {
      type: 'box',
      layout: 'vertical',
      contents: bodyContents,
    },
    footer: {
      type: 'box',
      layout: 'vertical',
      spacing: 'sm',
      contents: footerActions.map(action => ({
        type: 'button',
        style: 'link',
        height: 'sm',
        action: action,
      })),
      flex: 0,
    },
  };
};
