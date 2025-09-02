import { parseCsvToEvents } from './index';

describe('parseCsvToEvents', () => {
  const baseCsvContent = `schedule
schedule,,,,,,,,,,,,,,,,,,,,,,,,,,,,,
姓名,職位,8/31,9/1,9/2,9/3,9/4,9/5,9/6,9/7,9/8,9/9,9/10,9/11,9/12,9/13,9/14,9/15,9/16,9/17,9/18,9/19,9/20,9/21,9/22,9/23,9/24,9/25,9/26,9/27
傅臻,全職,,早接菜,早接菜,晚班,,早接菜,晚班,,早接菜,晚班,早接菜,,,,,早接菜,早接菜,晚班,,假,晚班,,早接菜,晚班,,早接菜,,
怡芳,全職,早班,,晚班,晚班,假,,早接菜,,,晚班,晚班,,早接菜,早接菜,早班,,晚班,晚班,,,早接菜,,,假,,早接菜,,
銘修,全職,早班,晚班,晚班,,早接菜,早接菜,早接菜,,,晚班,,晚班,晚班,晚班,早班,早接菜,早接菜,,晚班,,,,晚班,,晚班,,晚班,
泳舜,全職,,早接菜,早接菜,早接菜,晚班,,,,早班,,,早接菜,早接菜,早接菜,,早接菜,早接菜,晚班,,,,,早接菜,晚班,,酸點單,假,
皓文,全職,,晚班,,,,,,早班,,,晚班,晚班,,晚班,,,早班,,早接菜,早接菜,早接菜,,,,早接菜,晚班,,晚班
淑華,全職,早班,,,早班,早班,早班,,,早班,早班,,,,,早班,早班,,早班,,,,,早班,,早班,,
CJ,,,1430-22,,09-1630,09-1630,1430-22,1430-22,,09-1630,,09-1630,09-1630,09-1630,1430-22,,1430-22,,09-1630,09-1630,09-1630,1430-22,,09-1630,,09-1630,1430-22,1430-22,1430-22
大童支援,0,,,,,,,,,,,,,,,,,,,,,,,,,,,,
`;

  // Mock 當前年份以確保測試一致性
  const mockCurrentYear = 2025;
  const originalGetFullYear = Date.prototype.getFullYear;
  Date.prototype.getFullYear = jest.fn(() => mockCurrentYear);

  afterAll(() => {
    Date.prototype.getFullYear = originalGetFullYear; // 恢復原始的 Date.prototype.getFullYear
  });

  test('should correctly parse CSV with descriptive shifts for a specific person (怡芳)', () => {
    const personName = '怡芳';
    const events = parseCsvToEvents(baseCsvContent, personName);

    expect(events.length).toBeGreaterThan(0);
    expect(events[0]).toEqual(expect.objectContaining({
      title: '怡芳 早班',
      start: `${mockCurrentYear}-08-31T09:00:00+08:00`,
      end: `${mockCurrentYear}-08-31T17:00:00+08:00`,
    }));
    // 檢查 '怡芳' 的其他幾個特定事件
    expect(events).toContainEqual(expect.objectContaining({
      title: '怡芳 晚班',
      start: `${mockCurrentYear}-09-02T14:00:00+08:00`,
      end: `${mockCurrentYear}-09-02T22:00:00+08:00`,
    }));
    expect(events).toContainEqual(expect.objectContaining({
      title: '怡芳 早接菜',
      start: `${mockCurrentYear}-09-06T07:00:00+08:00`,
      end: `${mockCurrentYear}-09-06T15:00:00+08:00`,
    }));
    // 確保 '假' (休假) 被跳過
    const leaveEvent = events.find(event => event.title.includes('假'));
    expect(leaveEvent).toBeUndefined();
  });

  test('should return an empty array if personName is not found', () => {
    const personName = '不存在的人';
    const events = parseCsvToEvents(baseCsvContent, personName);
    expect(events).toEqual([]);
  });

  test('should return an empty array if header row is missing', () => {
    const noHeaderCsv = `傅臻,全職,,早接菜,早接菜,晚班,,早接菜,晚班,,早接菜,晚班,早接菜,,,,,早接菜,早接菜,晚班,,假,晚班,,早接菜,晚班,,早接菜,,`;
    const personName = '傅臻';
    const events = parseCsvToEvents(noHeaderCsv, personName);
    expect(events).toEqual([]);
  });

  test('should apply "早七" or "晚七" title for non-descriptive shifts (CJ)', () => {
    const personName = 'CJ';
    const events = parseCsvToEvents(baseCsvContent, personName);

    expect(events.length).toBeGreaterThan(0);

    // 這個從 14:30 開始，所以應該是 "晚七"
    expect(events).toContainEqual(expect.objectContaining({
      title: 'CJ 晚七',
      start: `${mockCurrentYear}-09-01T14:30:00+08:00`,
      end: `${mockCurrentYear}-09-01T22:00:00+08:00`,
    }));

    // 這個從 09:00 開始，所以應該是 "早七"
    expect(events).toContainEqual(expect.objectContaining({
      title: 'CJ 早七',
      start: `${mockCurrentYear}-09-03T09:00:00+08:00`,
      end: `${mockCurrentYear}-09-03T16:30:00+08:00`,
    }));
  });

  test('should handle empty shifts and "休" (rest) shifts correctly', () => {
    const customCsv = `姓名,職位,1/1,1/2,1/3
測試員,全職,早班,,休`;
    const personName = '測試員';
    const events = parseCsvToEvents(customCsv, personName);

    expect(events.length).toBe(1); // 只應該解析 '早班'
    expect(events[0]).toEqual(expect.objectContaining({
      title: '測試員 早班',
      start: `${mockCurrentYear}-01-01T09:00:00+08:00`,
      end: `${mockCurrentYear}-01-01T17:00:00+08:00`,
    }));
  });
});
