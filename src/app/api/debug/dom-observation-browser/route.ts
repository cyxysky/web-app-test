import { NextRequest, NextResponse } from 'next/server';
import {
  accessibilitySnapshotTestStatus,
  openAccessibilitySnapshotTestBrowser,
} from '@/server/browser/accessibility-snapshot-test.service';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET() {
  return NextResponse.json(accessibilitySnapshotTestStatus());
}

export async function POST(request: NextRequest) {
  const status = await openAccessibilitySnapshotTestBrowser(request.nextUrl.origin);
  return NextResponse.json(status, { status: status.ok ? 200 : 500 });
}
