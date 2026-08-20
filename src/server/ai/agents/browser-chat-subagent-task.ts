export type BrowserChatSubagentTaskInput = {
  instruction: string;
  title: string;
  url: string;
};

export type BrowserChatSubagentTask = BrowserChatSubagentTaskInput;

export function normalizeBrowserChatSubagentTasks(value: unknown): BrowserChatSubagentTask[] {
  const values = Array.isArray(value) ? value : [value];
  return values.flatMap((raw) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];
    const input = raw as Record<string, unknown>;
    const title = typeof input.title === 'string' ? input.title.trim() : '';
    const instruction = typeof input.instruction === 'string' ? input.instruction.trim() : '';
    const url = typeof input.url === 'string' ? input.url.trim() : '';
    if (!title || !instruction || !url || !URL.canParse(url)) return [];
    return [{ title, instruction, url }];
  });
}
