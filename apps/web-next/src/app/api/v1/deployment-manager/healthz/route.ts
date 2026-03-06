import { NextResponse } from 'next/server';

export async function GET() {
  return NextResponse.json({ success: true, status: 'ok', timestamp: new Date().toISOString() });
}
