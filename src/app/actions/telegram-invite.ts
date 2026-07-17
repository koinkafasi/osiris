'use server';

import { cookies } from 'next/headers';
import QRCode from 'qrcode';
import { verifySessionToken, SESSION_COOKIE_NAME } from '@/lib/session';

export async function getTelegramInviteQr(): Promise<{ svg: string } | { error: string }> {
  const secret = process.env.SESSION_SECRET;
  const token = (await cookies()).get(SESSION_COOKIE_NAME)?.value;
  const authed = secret ? await verifySessionToken(token, secret) : false;
  if (!authed) {
    return { error: 'Unauthorized' };
  }

  const inviteLink = process.env.TELEGRAM_GROUP_INVITE_LINK;
  if (!inviteLink) {
    return { error: 'Not configured' };
  }

  const svg = await QRCode.toString(inviteLink, { type: 'svg', margin: 1 });
  return { svg };
}
