import { NextRequest, NextResponse } from 'next/server';
import { artifactContentType } from '@webpilot/capability-file';
import { generateFileBuffer } from '@webpilot/capability-file/node';
import { requestApplicationUserId } from '@/server/auth/user-context';
import { apiError } from '@/server/http/api-request';

type RouteContext = { params: Promise<{ kind: string }> };

export async function GET(request: NextRequest, context: RouteContext) {
  try {
    requestApplicationUserId(request);
    const kind = (await context.params).kind;
    const fileName = kind === 'docx' ? 'WebPilot-新手示例.docx' : kind === 'xlsx' ? 'WebPilot-新手示例.xlsx' : '';
    if (!fileName) return new NextResponse('Not found', { status: 404 });
    const generated = kind === 'docx'
      ? await generateFileBuffer({
          blocks: [{ id: 'intro', type: 'text', markdown: '# WebPilot 文件演示\n\n这是一个安全的示例文档。请让 WebPilot 总结文档主题，并列出两条要点。' }],
          document: {},
          documentType: 'word',
          fileName,
        })
      : await generateFileBuffer({
          blocks: [{ id: 'sheet-1', type: 'sheet', name: '任务数据', children: [{ id: 'tasks', type: 'table', rows: [['项目', '状态', '负责人'], ['登录流程', '已完成', '测试用户'], ['导出验证', '待处理', '测试用户']] }] }],
          document: {},
          documentType: 'spreadsheet',
          fileName,
        });
    return new NextResponse(new Uint8Array(generated.buffer), {
      headers: {
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`,
        'Content-Type': artifactContentType(fileName),
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    return apiError(request, error, { fallback: 'Unable to create tutorial sample' });
  }
}
