import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSessionToken } from '@/lib/session';

const mockCookieGet = vi.fn();
vi.mock('next/headers', () => ({
  cookies: () => Promise.resolve({ get: mockCookieGet }),
}));

import { getTelegramInviteQr } from './telegram-invite';

describe('getTelegramInviteQr', () => {
  const SECRET = 'test-secret';

  beforeEach(() => {
    mockCookieGet.mockReset();
    process.env.SESSION_SECRET = SECRET;
    process.env.TELEGRAM_GROUP_INVITE_LINK = 'https://t.me/+testinvite';
  });

  it('returns Unauthorized when the session cookie is missing', async () => {
    mockCookieGet.mockReturnValue(undefined);
    expect(await getTelegramInviteQr()).toEqual({ error: 'Unauthorized' });
  });

  it('returns Unauthorized when the session cookie is invalid', async () => {
    mockCookieGet.mockReturnValue({ value: 'garbage-token' });
    expect(await getTelegramInviteQr()).toEqual({ error: 'Unauthorized' });
  });

  it('returns Not configured when the invite link env var is missing', async () => {
    delete process.env.TELEGRAM_GROUP_INVITE_LINK;
    const token = await createSessionToken(SECRET);
    mockCookieGet.mockReturnValue({ value: token });
    expect(await getTelegramInviteQr()).toEqual({ error: 'Not configured' });
  });

  it('returns an SVG QR code for a valid session', async () => {
    const token = await createSessionToken(SECRET);
    mockCookieGet.mockReturnValue({ value: token });
    const result = await getTelegramInviteQr();
    expect('svg' in result).toBe(true);
    expect((result as { svg: string }).svg).toContain('<svg');
  });
});
