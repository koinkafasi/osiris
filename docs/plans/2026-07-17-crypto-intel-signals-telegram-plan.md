# CoinHit Intelligence — Alt-Proje 1: Telegram Bildirimi + QR Daveti Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Kritik `crypto.signals` sinyallerini (whale_alert ≥5x eşik, liquidation_cascade) bir Telegram grubuna anlık bildirim olarak gönder; Osiris'in CryptoPanel'ine bu sinyalleri gösteren yeni bir sekme ve ekip üyelerinin QR okutarak gruba katılmasını sağlayan bir davet butonu ekle.

**Architecture:** `crypto-ingest` worker'ının mevcut `signals.py::_emit()` fonksiyonu, DB yazma+Redis publish'e ek olarak (best-effort, hiçbir zaman DB yazmasını engellemeyen) bir Telegram Bot API çağrısı yapar. Osiris tarafında yeni bir public `signals-feed` route'u (diğer 8 crypto route'la aynı desende) panel için veri sağlar; davet linki ise bir Server Action üzerinden — middleware'den bağımsız kendi session doğrulamasını yaparak — sadece SVG QR olarak, hiçbir zaman düz metin bir API yanıtı olarak dışarı çıkmadan sunulur.

**Tech Stack:** Python 3.11 (httpx, psycopg), Next.js 16 App Router / TypeScript (Server Actions, `qrcode` npm paketi), vitest, pytest.

**Design doc:** `docs/plans/2026-07-17-crypto-intel-signals-telegram-design.md`

## Global Constraints

- crypto-ingest HTTP çağrıları için mevcut `httpx` bağımlılığını kullan (`requests` gibi yeni bir HTTP kütüphanesi EKLEME — collectors.py zaten `httpx.Client(timeout=15)` deseniyle çalışıyor).
- Telegram gönderimi/QR üretimi hiçbir zaman ana veri akışını (DB yazma, sinyal üretimi) bloklamamalı veya crash ettirmemeli — best-effort, try/except ile sarılı.
- `TELEGRAM_BOT_TOKEN`, `TELEGRAM_CHAT_ID`, `TELEGRAM_GROUP_INVITE_LINK` asla `NEXT_PUBLIC_` önekiyle veya yeni bir public GET route üzerinden dışarı verilmez.
- Osiris route testleri mevcut projedeki 8 route'un deseniyle birebir aynı olmalı: sadece saf `format*Row` fonksiyonu test edilir, `GET()` handler'ı DB mock'lanarak test edilmez.
- Python testleri: `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest <dosya> -v` ile çalıştırılır.
- TS testleri: `cd ~/osiris && npx vitest run <dosya>` ile çalıştırılır.
- Her task kendi commit'i ile biter (frequent commits).

---

### Task 1 (crypto-ingest): `services/telegram.py` — Telegram gönderim yardımcıları

**Files:**
- Create: `/home/ubuntu/crypto-ingest/services/telegram.py`
- Test: `/home/ubuntu/crypto-ingest/services/test_telegram.py`

**Interfaces:**
- Produces: `send_telegram_message(text: str) -> None`, `format_signal_message(sig: dict) -> str`, module-level `_http` (patchable `httpx.Client` instance) — Task 2 bunları `from telegram import send_telegram_message, format_signal_message` ile tüketir.
- Consumes: `httpx` (mevcut bağımlılık), `os.environ["TELEGRAM_BOT_TOKEN"]`, `os.environ["TELEGRAM_CHAT_ID"]`.

- [ ] **Step 1: Test dosyasını yaz (başarısız olacak şekilde)**

`/home/ubuntu/crypto-ingest/services/test_telegram.py`:

```python
from unittest.mock import patch

import telegram


def test_format_signal_message_includes_emoji_severity_and_symbol():
    sig = {
        "signal_type": "whale_alert",
        "severity": "critical",
        "symbol": "BTC",
        "message": "BTC whale transfer: $5,000,000 -> 0x1234...",
    }
    text = telegram.format_signal_message(sig)
    assert "🐋" in text
    assert "CRITICAL" in text
    assert "BTC" in text
    assert "whale transfer" in text


def test_format_signal_message_handles_missing_symbol():
    sig = {"signal_type": "liquidation_cascade", "severity": "critical", "symbol": None, "message": "cascade"}
    text = telegram.format_signal_message(sig)
    assert "?" in text


def test_send_telegram_message_noop_when_token_missing(monkeypatch):
    monkeypatch.delenv("TELEGRAM_BOT_TOKEN", raising=False)
    monkeypatch.delenv("TELEGRAM_CHAT_ID", raising=False)
    with patch.object(telegram, "_http") as mock_http:
        telegram.send_telegram_message("test")
        mock_http.post.assert_not_called()


def test_send_telegram_message_posts_to_bot_api(monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "fake-token")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "-100123456")
    with patch.object(telegram, "_http") as mock_http:
        telegram.send_telegram_message("hello")
        mock_http.post.assert_called_once()
        args, kwargs = mock_http.post.call_args
        assert "fake-token" in args[0]
        assert kwargs["json"]["chat_id"] == "-100123456"
        assert kwargs["json"]["text"] == "hello"


def test_send_telegram_message_swallows_http_errors(monkeypatch):
    monkeypatch.setenv("TELEGRAM_BOT_TOKEN", "fake-token")
    monkeypatch.setenv("TELEGRAM_CHAT_ID", "-100123456")
    with patch.object(telegram, "_http") as mock_http:
        mock_http.post.side_effect = Exception("network down")
        telegram.send_telegram_message("hello")  # must not raise
```

- [ ] **Step 2: Testi çalıştır, `telegram` modülü olmadığı için fail ettiğini doğrula**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest test_telegram.py -v`
Expected: FAIL with `ModuleNotFoundError: No module named 'telegram'`. (Doğrulandı: bu venv'de üçüncü parti `python-telegram-bot` paketi kurulu değil — `telegram` adı `services/` dizininde tanımlayacağımız yerel modülle çakışmıyor.)

- [ ] **Step 3: `telegram.py`'yi yaz**

```python
"""Telegram Bot API'ye best-effort mesaj gonderimi. DB/sinyal akisini asla bloklamaz
veya crash ettirmez — token/chat-id eksikse sessizce no-op, HTTP hatasi sadece loglanir."""
import os

import httpx

_http = httpx.Client(timeout=15)

TELEGRAM_API_BASE = "https://api.telegram.org"

_SIGNAL_EMOJI = {
    "whale_alert": "🐋",
    "funding_extreme": "📈",
    "liquidation_cascade": "⚠️",
}


def format_signal_message(sig: dict) -> str:
    emoji = _SIGNAL_EMOJI.get(sig["signal_type"], "🚨")
    symbol = sig.get("symbol") or "?"
    return f"{emoji} [{sig['severity'].upper()}] {symbol}\n{sig['message']}"


def send_telegram_message(text: str) -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN")
    chat_id = os.environ.get("TELEGRAM_CHAT_ID")
    if not token or not chat_id:
        return
    try:
        resp = _http.post(
            f"{TELEGRAM_API_BASE}/bot{token}/sendMessage",
            json={"chat_id": chat_id, "text": text},
        )
        resp.raise_for_status()
    except Exception as e:
        print(f"[telegram] send failed (best-effort, non-fatal): {e}", flush=True)
```

- [ ] **Step 4: Testleri çalıştır, geçtiğini doğrula**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest test_telegram.py -v`
Expected: 5 passed

- [ ] **Step 5: `.env`'e yeni değişkenleri ekle (placeholder değerlerle, gerçek token operasyonel adımda girilecek)**

`/home/ubuntu/crypto-ingest/.env` dosyasına şu satırları ekle (gitignored, gerçek değerler Task 7'de girilecek):

```
TELEGRAM_BOT_TOKEN=
TELEGRAM_CHAT_ID=
```

- [ ] **Step 6: README'ye env değişkenlerini dokümante et**

`/home/ubuntu/crypto-ingest/README.md`'de `.env` değişkenlerinin listelendiği bölüme (CRYPTO_DB_PASSWORD, DATABASE_URL, CRYPTO_REDIS_URL'in yanına) şu satırları ekle:

```
TELEGRAM_BOT_TOKEN=      # @BotFather'dan alinan bot token'i — bossa Telegram bildirimleri sessizce devre disi kalir
TELEGRAM_CHAT_ID=        # Bildirimlerin gidecegi ozel grubun chat ID'si (negatif bir sayi, orn. -100123456789)
```

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/crypto-ingest
git add services/telegram.py services/test_telegram.py README.md
git commit -m "feat: add Telegram Bot API delivery helper for critical signals"
```

---

### Task 2 (crypto-ingest): `signals.py::_emit()` — kritik sinyallerde Telegram'a gönder

**Files:**
- Modify: `/home/ubuntu/crypto-ingest/services/signals.py:1-9` (imports), `signals.py:89-100` (`_emit`)
- Test: `/home/ubuntu/crypto-ingest/services/test_signals.py`

**Interfaces:**
- Consumes: `send_telegram_message(text: str) -> None`, `format_signal_message(sig: dict) -> str` (Task 1).
- Produces: değişmiş `_emit()` davranışı — başka hiçbir dosya bu değişikliğe bağımlı değil (kendi kendine yeten task).

- [ ] **Step 1: Test dosyasının başına `patch` ve `signals` modül importlarını ekle, iki yeni test yaz**

`test_signals.py`'nin en üstündeki importları şu şekilde güncelle (mevcut `from signals import (...)` satırını koru, üstüne ekle):

```python
import json
from unittest.mock import patch

import signals
from db import db
from signals import (
    evaluate_whale,
    evaluate_funding_extreme,
    evaluate_liquidation_cascade,
    _recently_signaled,
    _already_signaled_whale,
)
```

Dosyanın sonuna ekle:

```python
def test_emit_sends_telegram_for_critical_severity():
    test_symbol = "TELEGRAMTEST-CRITICAL"
    sig = {"signal_type": "liquidation_cascade", "severity": "critical", "symbol": test_symbol, "message": "test", "payload": {}}
    with db() as conn:
        conn.execute("DELETE FROM crypto.signals WHERE symbol=%s", (test_symbol,))
    try:
        with patch.object(signals, "send_telegram_message") as mock_send:
            signals._emit(sig)
            mock_send.assert_called_once()
    finally:
        with db() as conn:
            conn.execute("DELETE FROM crypto.signals WHERE symbol=%s", (test_symbol,))


def test_emit_skips_telegram_for_warning_severity():
    test_symbol = "TELEGRAMTEST-WARNING"
    sig = {"signal_type": "funding_extreme", "severity": "warning", "symbol": test_symbol, "message": "test", "payload": {}}
    with db() as conn:
        conn.execute("DELETE FROM crypto.signals WHERE symbol=%s", (test_symbol,))
    try:
        with patch.object(signals, "send_telegram_message") as mock_send:
            signals._emit(sig)
            mock_send.assert_not_called()
    finally:
        with db() as conn:
            conn.execute("DELETE FROM crypto.signals WHERE symbol=%s", (test_symbol,))
```

- [ ] **Step 2: Testleri çalıştır, fail ettiğini doğrula**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest test_signals.py -v -k emit`
Expected: FAIL — `signals` modülünde henüz `send_telegram_message` adında bir attribute yok, `mock_send.assert_called_once()` `AssertionError` verir (çünkü henüz çağrılmıyor).

- [ ] **Step 3: `signals.py`'yi güncelle**

`signals.py:1-9` mevcut importları:

```python
import json
import os

import redis as redis_lib

from db import db
```

şu şekilde değiştir:

```python
import json
import os

import redis as redis_lib

from db import db
from telegram import send_telegram_message, format_signal_message
```

`signals.py:89-100` mevcut `_emit`:

```python
def _emit(sig: dict) -> None:
    with db() as conn:
        conn.execute(
            """INSERT INTO crypto.signals (signal_type, severity, symbol, message, payload)
               VALUES (%s,%s,%s,%s,%s)""",
            (sig["signal_type"], sig["severity"], sig.get("symbol"), sig["message"],
             json.dumps(sig.get("payload", {}))),
        )
    try:
        _redis().publish("crypto.signals", json.dumps(sig))
    except Exception as e:
        print(f"[signals] redis publish failed (DB write succeeded): {e}", flush=True)
```

şu şekilde değiştir:

```python
def _emit(sig: dict) -> None:
    with db() as conn:
        conn.execute(
            """INSERT INTO crypto.signals (signal_type, severity, symbol, message, payload)
               VALUES (%s,%s,%s,%s,%s)""",
            (sig["signal_type"], sig["severity"], sig.get("symbol"), sig["message"],
             json.dumps(sig.get("payload", {}))),
        )
    try:
        _redis().publish("crypto.signals", json.dumps(sig))
    except Exception as e:
        print(f"[signals] redis publish failed (DB write succeeded): {e}", flush=True)
    if sig["severity"] == "critical":
        send_telegram_message(format_signal_message(sig))
```

- [ ] **Step 4: Tüm signals testlerini çalıştır, geçtiğini doğrula**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest test_signals.py -v`
Expected: tüm testler (yeni 2 dahil, toplam 9) passed

- [ ] **Step 5: Worker'ı canlıda yeniden başlatmadan ÖNCE tam test paketini çalıştır (regresyon kontrolü)**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest -v`
Expected: tüm dosyalardaki testler passed (telegram.py'nin diğer modülleri bozmadığını doğrula)

- [ ] **Step 6: Commit**

```bash
cd /home/ubuntu/crypto-ingest
git add services/signals.py services/test_signals.py
git commit -m "feat: send critical signals to Telegram from _emit()"
```

---

### Task 3 (osiris): `src/app/api/crypto/signals-feed/route.ts` — public sinyal akışı route'u

**Files:**
- Create: `/home/ubuntu/osiris/src/app/api/crypto/signals-feed/route.ts`
- Test: `/home/ubuntu/osiris/src/app/api/crypto/signals-feed/route.test.ts`

**Interfaces:**
- Produces: `GET()` handler → `{ signals: SignalRow[], timestamp: string }` | `{ signals: [], error: string }`; exported `formatSignalRow(row: SignalRow): SignalRow`; exported `SignalRow` interface `{ signal_type: string; severity: string; symbol: string | null; message: string; created_at: string }`.
- Consumes: `getCryptoDb()` (mevcut `@/lib/cryptoDb`).
- Task 5 bu response şeklini (`SignalRow`, `SignalsFeedResponse`) `CryptoPanel.tsx` içinde mirror edip tüketecek.

- [ ] **Step 1: Test dosyasını yaz (başarısız olacak şekilde)**

`/home/ubuntu/osiris/src/app/api/crypto/signals-feed/route.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { formatSignalRow } from './route';

describe('formatSignalRow', () => {
  it('trims stray whitespace from text fields for clean display', () => {
    const row = { signal_type: ' whale_alert ', severity: 'critical', symbol: ' BTC', message: 'BTC whale transfer: $5,000,000 ', created_at: '2026-07-17T06:00:00Z' };
    const result = formatSignalRow(row as any);
    expect(result.signal_type).toBe('whale_alert');
    expect(result.symbol).toBe('BTC');
    expect(result.message).toBe('BTC whale transfer: $5,000,000');
  });

  it('leaves a null symbol as null', () => {
    const row = { signal_type: 'liquidation_cascade', severity: 'critical', symbol: null, message: 'cascade', created_at: '2026-07-17T06:00:00Z' };
    expect(formatSignalRow(row as any).symbol).toBeNull();
  });
});
```

- [ ] **Step 2: Testi çalıştır, `route.ts` bulunamadığı için fail ettiğini doğrula**

Run: `cd ~/osiris && npx vitest run src/app/api/crypto/signals-feed/route.test.ts`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: `route.ts`'yi yaz**

```typescript
import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface SignalRow {
  signal_type: string;
  severity: string;
  symbol: string | null;
  message: string;
  created_at: string;
}

export function formatSignalRow(row: SignalRow): SignalRow {
  return {
    ...row,
    signal_type: row.signal_type.trim(),
    symbol: row.symbol === null ? null : row.symbol.trim(),
    message: row.message.trim(),
  };
}

export async function GET() {
  try {
    const db = getCryptoDb();
    const { rows } = await db.query<SignalRow>(
      `SELECT signal_type, severity, symbol, message, created_at
       FROM crypto.signals
       WHERE severity = 'critical' AND created_at > now() - interval '24 hours'
       ORDER BY created_at DESC
       LIMIT 20`
    );
    return NextResponse.json(
      { signals: rows.map(formatSignalRow), timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/signals-feed fetch error:', error);
    return NextResponse.json({ signals: [], error: 'Failed' }, { status: 500 });
  }
}
```

- [ ] **Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `cd ~/osiris && npx vitest run src/app/api/crypto/signals-feed/route.test.ts`
Expected: 2 passed

- [ ] **Step 5: Commit**

```bash
cd /home/ubuntu/osiris
git add src/app/api/crypto/signals-feed/route.ts src/app/api/crypto/signals-feed/route.test.ts
git commit -m "feat: add public signals-feed route for the CryptoPanel intel card"
```

---

### Task 4 (osiris): `src/app/actions/telegram-invite.ts` — QR daveti Server Action'ı

**Files:**
- Create: `/home/ubuntu/osiris/src/app/actions/telegram-invite.ts`
- Test: `/home/ubuntu/osiris/src/app/actions/telegram-invite.test.ts`
- Modify: `/home/ubuntu/osiris/package.json` (yeni bağımlılık: `qrcode`, `@types/qrcode`)

**Interfaces:**
- Produces: `getTelegramInviteQr(): Promise<{ svg: string } | { error: string }>`.
- Consumes: `verifySessionToken`, `SESSION_COOKIE_NAME`, `createSessionToken` (mevcut `@/lib/session`), `cookies` (`next/headers`), `qrcode` npm paketi.
- Task 5 bu fonksiyonu doğrudan import edip `CryptoPanel.tsx`'ten çağıracak.

- [ ] **Step 1: `qrcode` bağımlılığını kur**

Run: `cd ~/osiris && npm install qrcode && npm install --save-dev @types/qrcode`
Expected: `package.json`'a `qrcode` (dependencies) ve `@types/qrcode` (devDependencies) eklenir, `package-lock.json` güncellenir.

- [ ] **Step 2: Test dosyasını yaz (başarısız olacak şekilde)**

`/home/ubuntu/osiris/src/app/actions/telegram-invite.test.ts`:

```typescript
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
```

- [ ] **Step 3: Testi çalıştır, `telegram-invite` bulunamadığı için fail ettiğini doğrula**

Run: `cd ~/osiris && npx vitest run src/app/actions/telegram-invite.test.ts`
Expected: FAIL — `Cannot find module './telegram-invite'`

- [ ] **Step 4: `telegram-invite.ts`'yi yaz**

```typescript
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
```

- [ ] **Step 5: Testi çalıştır, geçtiğini doğrula**

Run: `cd ~/osiris && npx vitest run src/app/actions/telegram-invite.test.ts`
Expected: 4 passed

- [ ] **Step 6: `.env`'e yeni değişkeni ekle (placeholder, gerçek değer Task 7'de)**

`/home/ubuntu/osiris/.env` dosyasına ekle:

```
TELEGRAM_GROUP_INVITE_LINK=
```

- [ ] **Step 7: Commit**

```bash
cd /home/ubuntu/osiris
git add src/app/actions/telegram-invite.ts src/app/actions/telegram-invite.test.ts package.json package-lock.json
git commit -m "feat: add Server Action serving the Telegram invite QR behind session auth"
```

---

### Task 5 (osiris): `CryptoPanel.tsx` — Canlı İstihbarat sekmesi + QR daveti butonu

**Files:**
- Modify: `/home/ubuntu/osiris/src/components/CryptoPanel.tsx`

**Interfaces:**
- Consumes: `formatSignalRow`'un ürettiği response şekli (`SignalRow`, Task 3 — mirror edilerek, cross-file import DEĞİL, mevcut dosyanın tepesindeki "mirrored from route.ts" yorumuyla tutarlı), `getTelegramInviteQr` (Task 4, doğrudan import).
- Produces: yok (bu, zincirdeki son UI task'ı).

- [ ] **Step 1: Import satırlarını güncelle**

`CryptoPanel.tsx:6-10` mevcut:

```typescript
import {
  Bitcoin, TrendingUp, TrendingDown, ChevronDown, ChevronUp,
  Zap, Waves, Flame, Layers, Coins, Globe2, ShieldAlert, Maximize2, Minimize2,
} from 'lucide-react';
```

şu şekilde değiştir:

```typescript
import {
  Bitcoin, TrendingUp, TrendingDown, ChevronDown, ChevronUp,
  Zap, Waves, Flame, Layers, Coins, Globe2, ShieldAlert, Maximize2, Minimize2,
  Siren, QrCode,
} from 'lucide-react';
import { getTelegramInviteQr } from '@/app/actions/telegram-invite';
```

- [ ] **Step 2: Yeni interface'leri ekle**

`CryptoPanel.tsx:63-69` (mevcut `ComplianceRow` interface'inin hemen altına) ekle:

```typescript
interface SignalRow {
  signal_type: string;
  severity: string;
  symbol: string | null;
  message: string;
  created_at: string;
}
```

`CryptoPanel.tsx:78` (mevcut `ComplianceResponse` satırının hemen altına) ekle:

```typescript
interface SignalsFeedResponse { signals: SignalRow[]; error?: string }
```

- [ ] **Step 3: `SectionKey` ve `SECTIONS`'ı güncelle**

`CryptoPanel.tsx:80` mevcut:

```typescript
type SectionKey = 'markets' | 'derivatives' | 'whales' | 'liquidations' | 'defi' | 'stablecoins' | 'geo' | 'compliance';
```

şu şekilde değiştir:

```typescript
type SectionKey = 'markets' | 'derivatives' | 'whales' | 'liquidations' | 'defi' | 'stablecoins' | 'geo' | 'compliance' | 'signals';
```

`CryptoPanel.tsx:82-91` mevcut `SECTIONS` dizisinin sonuna (compliance satırından sonra, kapanış `];`'den önce) ekle:

```typescript
  { key: 'signals', label: 'SIGNALS', icon: Siren },
```

- [ ] **Step 4: Veri çekme ve `loadedBySection`'ı güncelle**

`CryptoPanel.tsx:173` (`compliance` satırının hemen altına) ekle:

```typescript
  const signals = useCryptoFeed<SignalsFeedResponse>('signals-feed', 60000);
```

`CryptoPanel.tsx:175-184` mevcut `loadedBySection` objesine (`compliance: compliance !== null,` satırının altına) ekle:

```typescript
    signals: signals !== null,
```

- [ ] **Step 5: Popover state + handler ekle**

`CryptoPanel.tsx:154-164` (component gövdesinin başına, `rowLimit` tanımından sonra) ekle:

```typescript
  const [showInvite, setShowInvite] = useState(false);
  const [inviteQr, setInviteQr] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [inviteLoading, setInviteLoading] = useState(false);

  const handleInviteClick = () => {
    const next = !showInvite;
    setShowInvite(next);
    if (next && !inviteQr && !inviteLoading) {
      setInviteLoading(true);
      setInviteError(null);
      getTelegramInviteQr()
        .then((result) => {
          if ('svg' in result) setInviteQr(result.svg);
          else setInviteError(result.error);
        })
        .catch(() => setInviteError('İstek başarısız oldu'))
        .finally(() => setInviteLoading(false));
    }
  };
```

- [ ] **Step 6: Header'a QR butonunu ekle**

`CryptoPanel.tsx:196-202` mevcut:

```typescript
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--alert-green)] animate-osiris-pulse" />
          <button onClick={(e) => { e.stopPropagation(); setMaximized(!maximized); if (!expanded && !maximized) setExpanded(true); }} className="hover:text-white transition-colors" title={maximized ? 'Restore' : 'Maximize'}>
            {maximized ? <Minimize2 className="w-3.5 h-3.5 text-[var(--text-muted)]" /> : <Maximize2 className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
          </button>
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-[var(--text-muted)]" /> : <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
        </div>
```

şu şekilde değiştir:

```typescript
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--alert-green)] animate-osiris-pulse" />
          <span className="relative">
            <button onClick={(e) => { e.stopPropagation(); handleInviteClick(); }} className="hover:text-white transition-colors" title="Telegram'a Katıl">
              <QrCode className="w-3.5 h-3.5 text-[var(--text-muted)]" />
            </button>
            {showInvite && (
              <div
                onClick={(e) => e.stopPropagation()}
                className="absolute right-0 top-full mt-2 z-[10000] w-48 p-3 rounded-lg border border-[var(--border-primary)] bg-[#0a0a09] shadow-xl"
              >
                {inviteLoading && <div className="text-[9px] font-mono text-[var(--text-muted)]">Yükleniyor...</div>}
                {inviteError && <div className="text-[9px] font-mono text-[var(--alert-red)]">{inviteError}</div>}
                {inviteQr && <div className="[&_svg]:w-full [&_svg]:h-auto" dangerouslySetInnerHTML={{ __html: inviteQr }} />}
              </div>
            )}
          </span>
          <button onClick={(e) => { e.stopPropagation(); setMaximized(!maximized); if (!expanded && !maximized) setExpanded(true); }} className="hover:text-white transition-colors" title={maximized ? 'Restore' : 'Maximize'}>
            {maximized ? <Minimize2 className="w-3.5 h-3.5 text-[var(--text-muted)]" /> : <Maximize2 className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
          </button>
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-[var(--text-muted)]" /> : <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
        </div>
```

- [ ] **Step 7: Sinyal listesi render bloğunu ekle**

`CryptoPanel.tsx:318-332` (mevcut `compliance` render bloğunun kapanışından hemen sonra, `</div>` (content div'inin kapanışından ÖNCE)) ekle:

```typescript
              {activeSection === 'signals' && signals && (
                signals.signals.length
                  ? signals.signals.slice(0, rowLimit(15)).map((s, i) => (
                      <Row key={`${s.signal_type}-${s.created_at}-${i}`}
                        left={s.message}
                        right={s.symbol ?? s.signal_type}
                        rightColor="var(--alert-red)" />
                    ))
                  : <EmptyRow label="Son 24 saatte kritik sinyal yok" />
              )}
```

- [ ] **Step 8: Dev sunucusunda görsel doğrulama**

Run: `cd ~/osiris && npm run dev` (zaten çalışıyorsa atla), tarayıcıda `localhost:3000` (login sonrası) → CryptoPanel'de "SIGNALS" sekmesinin göründüğünü, tıklandığında (veri varsa) satırların, yoksa "Son 24 saatte kritik sinyal yok" mesajının göründüğünü; başlıktaki QR ikonuna tıklanınca popover'ın açılıp `TELEGRAM_GROUP_INVITE_LINK` henüz boş olduğu için "Not configured" hatası gösterdiğini doğrula (gerçek link Task 7'de girilecek).

- [ ] **Step 9: Commit**

```bash
cd /home/ubuntu/osiris
git add src/components/CryptoPanel.tsx
git commit -m "feat: add live signals tab and Telegram QR invite button to CryptoPanel"
```

---

### Task 6 (osiris): README güncellemesi + tam test paketi regresyonu

**Files:**
- Modify: `/home/ubuntu/osiris/README.md`

- [ ] **Step 1: README'ye yeni env değişkenlerini ekle**

`.env` değişkenlerinin listelendiği bölüme (`CRYPTO_SIGNALS_API_KEY` satırının yanına) ekle:

```
TELEGRAM_GROUP_INVITE_LINK=   # Telegram grup davet linki — CryptoPanel'deki QR daveti icin (bossa "Not configured" hatasi gosterilir)
```

- [ ] **Step 2: Tam test paketini çalıştır (regresyon kontrolü)**

Run: `cd ~/osiris && npx vitest run`
Expected: tüm testler (yeni 6 dahil: `signals-feed` 2 + `telegram-invite` 4) passed, hiçbir mevcut test kırılmamış.

- [ ] **Step 3: Commit**

```bash
cd /home/ubuntu/osiris
git add README.md
git commit -m "docs: document TELEGRAM_GROUP_INVITE_LINK env var"
```

---

## Task 7 (Manuel — kod değil, kullanıcı tarafından yapılır)

Bu adımlar subagent tarafından yapılamaz çünkü gerçek bir Telegram hesabı üzerinden manuel işlem gerektiriyor:

1. **Bot oluştur:** Telegram'da @BotFather'a git, `/newbot` ile yeni bir bot oluştur, verilen token'ı not al.
2. **Grup oluştur:** Telegram'da özel bir grup aç (örn. "CoinHit İstihbarat"), yeni botu gruba üye olarak ekle.
3. **Chat ID'yi bul:** Gruba herhangi bir mesaj gönder, sonra `https://api.telegram.org/bot<TOKEN>/getUpdates` adresini ziyaret et, yanıttaki `"chat":{"id":...}` değerini not al (negatif bir sayı olacak).
4. **Davet linkini al:** Grup bilgisi → "Davet Linki Oluştur" ile bir link üret, not al.
5. **`.env` dosyalarını doldur:**
   - `~/crypto-ingest/.env`: `TELEGRAM_BOT_TOKEN=<2. adımdaki token>`, `TELEGRAM_CHAT_ID=<3. adımdaki ID>`
   - `~/osiris/.env`: `TELEGRAM_GROUP_INVITE_LINK=<4. adımdaki link>`
6. **Servisleri yeniden başlat:**
   - `sudo systemctl restart crypto-ingest.service`
   - Osiris PM2 process'ini restart et (`pm2 restart osiris` veya mevcut process adıyla).
7. **Uçtan uca doğrula:**
   - CryptoPanel'de QR ikonuna tıkla → gerçek QR kodun göründüğünü doğrula, telefonla okutup gruba katıl.
   - Gerçek bir kritik sinyal oluşana kadar bekle (veya `crypto.signals` tablosuna manuel bir test satırı ekleyip `signals.py::_emit()`'i tetikleyerek) Telegram grubuna mesajın gerçekten düştüğünü doğrula.

---

## Ledger

Her task tamamlandığında `.superpowers/sdd/progress.md`'ye (ilgili repo'da) bir satır eklenir: task no, kısa açıklama, review verdict, commit hash.
