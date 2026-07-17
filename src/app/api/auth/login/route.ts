import { NextResponse } from 'next/server';
import { createSessionToken, constantTimeEqual, SESSION_COOKIE_NAME } from '@/lib/session';

export async function POST(req: Request) {
  const username = process.env.SITE_USERNAME;
  const password = process.env.SITE_PASSWORD;
  const secret = process.env.SESSION_SECRET;

  if (!username || !password || !secret) {
    return NextResponse.json({ error: 'Login is not configured' }, { status: 503 });
  }

  let body: { username?: string; password?: string };
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: 'Invalid request' }, { status: 400 });
  }

  const okUser = constantTimeEqual(body.username || '', username);
  const okPass = constantTimeEqual(body.password || '', password);

  if (!okUser || !okPass) {
    return NextResponse.json({ error: 'Invalid credentials' }, { status: 401 });
  }

  const token = await createSessionToken(secret);
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE_NAME, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 60 * 60 * 24 * 30, // 30 gun
  });
  return res;
}
