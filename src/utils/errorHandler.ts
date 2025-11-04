
import { Client, TemplateMessage } from '@line/bot-sdk';
import { DuplicateEventError } from '../services/googleCalendarService';

export const handleCreateError = (error: any, userId: string, lineClient: Client) => {
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
  console.error('Error object type:', typeof error);
  console.error('Error object:', error);
  console.error("!!!!!!!!!! DETAILED ERROR REPORT START !!!!!!!!!!");
  console.error(JSON.stringify(error, null, 2));
  console.error("!!!!!!!!!! DETAILED ERROR REPORT END !!!!!!!!!!");
  return lineClient.pushMessage(userId, { type: 'text', text: '抱歉，新增日曆事件時發生錯誤。' });
};
