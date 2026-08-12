import { NextRequest, NextResponse } from 'next/server';
import { artifactContentType } from '@/server/files/file-format-registry';
import { generateFileBuffer } from '@/server/ai/agents/document-artifact-generators';
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
          fileName,
          content: '# WebPilot 文件演练\n\n这是一个安全的示例文档。请让 WebPilot 总结文档主题，并列出两条要点。',
        })
      : await generateFileBuffer({
          fileName,
          sheets: [{ name: '任务数据', rows: [['项目', '状态', '负责人'], ['登录流程', '已完成', '测试用户'], ['导出验证', '待处理', '测试用户']] }],
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
