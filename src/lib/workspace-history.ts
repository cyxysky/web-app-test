import type { Language } from '@/i18n/language';

export type WorkspaceHistoryItem = {
  createdAt?: string;
  updatedAt?: string;
};

export type WorkspaceHistoryGroup<T> = {
  ariaLabel: string;
  day: string;
  items: T[];
  key: string;
  month: string;
};

const chineseMonthLabels = [
  '一月',
  '二月',
  '三月',
  '四月',
  '五月',
  '六月',
  '七月',
  '八月',
  '九月',
  '十月',
  '十一月',
  '十二月',
] as const;

const englishMonthLabels = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

function defaultWorkspaceHistoryTimestamp<T>(value: T) {
  const item = value as WorkspaceHistoryItem;
  return item.updatedAt || item.createdAt;
}

export function groupWorkspaceHistory<T>(
  items: readonly T[],
  language: Language,
  getTimestamp: (item: T) => string | undefined = defaultWorkspaceHistoryTimestamp,
): Array<WorkspaceHistoryGroup<T>> {
  const groups: Array<WorkspaceHistoryGroup<T>> = [];
  const groupsByKey = new Map<string, WorkspaceHistoryGroup<T>>();

  for (const item of items) {
    const timestamp = Date.parse(getTimestamp(item) || '');
    const date = Number.isFinite(timestamp) ? new Date(timestamp) : null;
    const year = date?.getFullYear();
    const monthIndex = date?.getMonth();
    const day = date?.getDate();
    const validDate = year !== undefined && monthIndex !== undefined && day !== undefined;
    const key = validDate
      ? `${year}-${String(monthIndex + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
      : 'unknown';
    let group = groupsByKey.get(key);

    if (!group) {
      const month = validDate
        ? (language === 'en' ? englishMonthLabels[monthIndex] : chineseMonthLabels[monthIndex])
        : (language === 'en' ? 'Unknown' : '未知');
      group = {
        ariaLabel: validDate
          ? (language === 'en' ? `${month} ${day}, ${year}` : `${year}年${monthIndex + 1}月${day}日`)
          : (language === 'en' ? 'Unknown date' : '未知日期'),
        day: validDate ? String(day) : '—',
        items: [],
        key,
        month,
      };
      groupsByKey.set(key, group);
      groups.push(group);
    }

    group.items.push(item);
  }

  return groups;
}
