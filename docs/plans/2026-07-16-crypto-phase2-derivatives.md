# CoinHit Kripto İstihbarat Katmanı — Faz 2: Türev + Likidasyon

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task.

**Goal:** `crypto-ingest` worker'ına Binance Futures türev verisi (funding rate, open interest) ve gerçek-zamanlı likidasyon takibi eklemek; Osiris'te bunları sunan iki yeni API rotası açmak.

**Architecture:** Mevcut `collectors.py`'ye iki yeni toplayıcı eklenir: `collect_derivatives()` (ccxt ile Binance Futures REST, mevcut polling döngüsüne 60sn aralıkla eklenir) ve likidasyonlar için ayrı bir bileşen — `liquidation_listener.py`, Binance'in public `!forceOrder@arr` websocket akışına bağlanan, **ayrı bir arka plan thread'inde** çalışan sürekli dinleyici (ana polling döngüsünü asyncio'ya çevirmeden, `threading` ile izole edilir — mevcut Faz 1 worker'ının basitliğini bozmaz). Osiris tarafında aynı kalıpla iki yeni salt-okunur rota.

**Tech Stack:** ccxt (Binance Futures — `defaultType: 'future'`), Python `threading` + `websockets` kütüphanesi (yeni bağımlılık), PostgreSQL (aynı `crypto-db`), Next.js/TypeScript (Osiris rotaları), pytest, vitest.

**Referans:** Ana plan — `docs/plans/2026-07-13-crypto-intelligence-layer.md`, Faz 1'in tamamlanmış hali (`~/crypto-ingest`, `~/osiris` — `feature/crypto-intelligence-layer` branch, şu an `master`'a merge edilmemiş, GitHub'da PR bekliyor).

---

## Ortam Notları — Faz 2'ye özel canlı doğrulanmış bilgiler

- **ccxt Binance Futures desteği** (bu oturumda canlı test edildi):
  - `fetch_funding_rate(symbol)` → `{'symbol', 'fundingRate', 'fundingTimestamp', 'markPrice', 'indexPrice', ...}` — çalışıyor, keyless.
  - `fetch_open_interest(symbol)` → `{'symbol', 'openInterestAmount', 'openInterestValue': None, 'timestamp', ...}` — çalışıyor ama `openInterestValue` Binance için hep `None` döner; USD değeri **kendimiz hesaplamalıyız**: `openInterestAmount * markPrice` (markPrice'ı `fetch_funding_rate` çağrısından alıyoruz, ekstra çağrı gerekmez).
  - `fetch_long_short_ratio` **yok** (`has['fetchLongShortRatio'] == False`), sadece `fetch_long_short_ratio_history` var (farklı parametreler gerektiren bir history endpoint). **Kapsam dışı bırakıldı** (YAGNI) — orijinal taslaktaki `long_short_ratio` kolonu bu yüzden şemadan çıkarıldı.
  - Futures sembol formatı spot'tan farklı: `'BTC/USDT:USDT'` (ccxt'nin unified perpetual futures gösterimi), spot'taki `'BTC/USDT'` değil.
  - `fetch_open_interest`/`fetch_funding_rate` **tekil** sembol alır (`fetchOpenInterests` — çoğul — desteklenmiyor), yani her sembol için ayrı çağrı gerekir; `enableRateLimit: True` zaten hız sınırlamasını hallediyor.
- **Likidasyon**: ccxt'de Binance için ne `fetchLiquidations` ne `watchLiquidations` var. Binance'in de likidasyonlar için REST endpoint'i yok — sadece websocket (`wss://fstream.binance.com/ws/!forceOrder@arr`, **keyless, public**). Bu oturumda canlı bağlantı test edildi, çalışıyor. Mesaj şekli (Binance resmi format):
  ```json
  {"e":"forceOrder","E":1568014460893,"o":{"s":"BTCUSDT","S":"SELL","o":"LIMIT","f":"IOC","q":"0.014","p":"9910","ap":"9910","X":"FILLED","l":"0.014","z":"0.014","T":1568014460893}}
  ```
  `o.S`: `"SELL"` = long pozisyon likide edildi, `"BUY"` = short pozisyon likide edildi. `value_usd = float(o.q) * float(o.ap)`.
- **`websockets` paketi** zaten `~/crypto-ingest/.venv`'e kuruldu (`websockets==16.1`) bu oturumda — implementer tekrar kurmasın, sadece `requirements.txt`'ye ekleyip import etsin.
- **worker.py'nin thread güvenliği**: `services/db.py`'nin `db()` fonksiyonu her çağrıda yeni bir `psycopg.connect()` açıyor (paylaşılan connection yok) — bu yüzden ana polling thread'i ile likidasyon dinleyici thread'i aynı `db()` fonksiyonunu güvenle paralel çağırabilir, ekstra kilitleme gerekmez.

---

## FAZ 2 — Görevler (tam TDD detayı)

### Task 2.1: `crypto.derivatives` ve `crypto.liquidations` şeması

**Files:**
- Create: `~/crypto-ingest/db/phase2_schema.sql`

**Step 1: Şema dosyasını yaz**

```sql
-- CoinHit Kripto İstihbarat Katmanı — Faz 2: türev + likidasyon şeması
CREATE TABLE IF NOT EXISTS crypto.derivatives (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,              -- 'BTC', 'ETH', ... (spot sembolüyle aynı format, futures süfiksi olmadan)
  funding_rate REAL,
  mark_price NUMERIC(20,8),
  open_interest_usd NUMERIC(24,2),
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS derivatives_symbol_time_idx ON crypto.derivatives (symbol, collected_at DESC);

CREATE TABLE IF NOT EXISTS crypto.liquidations (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  side TEXT NOT NULL,                -- 'long' | 'short' (likide edilen pozisyon yönü)
  value_usd NUMERIC(20,2) NOT NULL,
  price_usd NUMERIC(20,8) NOT NULL,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS liquidations_time_idx ON crypto.liquidations (observed_at DESC);
```

**Step 2: Uygula ve doğrula**

Run: `docker exec -i crypto-db psql -U crypto -d crypto < ~/crypto-ingest/db/phase2_schema.sql`
Expected: `CREATE TABLE` x2, `CREATE INDEX` x2.

Run: `docker exec -i crypto-db psql -U crypto -d crypto -c '\dt crypto.*'`
Expected: `crypto.derivatives` ve `crypto.liquidations` listede, önceki `markets`/`whale_txns` ile birlikte.

**Step 3: Commit**

```bash
cd ~/crypto-ingest && git add db/phase2_schema.sql && git commit -m "feat(crypto): add derivatives and liquidations schema"
```

---

### Task 2.2: Türev toplayıcı (`collect_derivatives`)

**Files:**
- Modify: `~/crypto-ingest/services/collectors.py`
- Modify: `~/crypto-ingest/services/test_collectors.py`

**Step 1: Saf dönüşüm fonksiyonu için başarısız test yaz**

```python
# test_collectors.py'ye ekle
from collectors import parse_derivative

def test_parse_derivative_computes_open_interest_usd():
    funding = {"symbol": "BTC/USDT:USDT", "fundingRate": 0.0000503, "markPrice": 64176.0}
    open_interest = {"openInterestAmount": 100939.231}
    result = parse_derivative("BTC/USDT:USDT", funding, open_interest)
    assert result["symbol"] == "BTC"
    assert result["funding_rate"] == 0.0000503
    assert result["mark_price"] == 64176.0
    assert result["open_interest_usd"] == 100939.231 * 64176.0

def test_parse_derivative_handles_missing_open_interest_amount():
    funding = {"symbol": "ETH/USDT:USDT", "fundingRate": 0.0001, "markPrice": 3000.0}
    result = parse_derivative("ETH/USDT:USDT", funding, {})
    assert result["open_interest_usd"] is None
```

**Step 2: Çalıştır, FAIL olduğunu doğrula**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest test_collectors.py -v -k derivative`
Expected: `ImportError: cannot import name 'parse_derivative'` ile FAIL.

**Step 3: Implementasyon**

```python
# collectors.py'ye ekle

FUTURES_SYMBOLS = [
    'BTC/USDT:USDT', 'ETH/USDT:USDT', 'BNB/USDT:USDT', 'SOL/USDT:USDT', 'XRP/USDT:USDT',
    'ADA/USDT:USDT', 'DOGE/USDT:USDT', 'DOT/USDT:USDT', 'LTC/USDT:USDT',
    'AVAX/USDT:USDT', 'LINK/USDT:USDT', 'ATOM/USDT:USDT', 'NEAR/USDT:USDT',
    'APT/USDT:USDT', 'ARB/USDT:USDT', 'OP/USDT:USDT', 'SUI/USDT:USDT',
]

_futures_exchange = ccxt.binance({"enableRateLimit": True, "options": {"defaultType": "future"}})


def parse_derivative(symbol: str, funding: dict, open_interest: dict) -> dict:
    """fetch_funding_rate + fetch_open_interest sonuçlarını crypto.derivatives satırına çevirir."""
    mark_price = funding.get("markPrice")
    oi_amount = open_interest.get("openInterestAmount")
    open_interest_usd = (oi_amount * mark_price) if (oi_amount is not None and mark_price is not None) else None
    return {
        "symbol": symbol.split("/")[0],
        "funding_rate": funding.get("fundingRate"),
        "mark_price": mark_price,
        "open_interest_usd": open_interest_usd,
    }


def collect_derivatives() -> int:
    """Her FUTURES_SYMBOLS için funding rate + open interest çeker, crypto.derivatives'e yazar."""
    rows = []
    for sym in FUTURES_SYMBOLS:
        try:
            funding = _futures_exchange.fetch_funding_rate(sym)
            oi = _futures_exchange.fetch_open_interest(sym)
            rows.append(parse_derivative(sym, funding, oi))
        except Exception as e:
            print(f"[derivatives] {sym} failed: {e}", flush=True)
            continue
    if not rows:
        return 0
    with db() as conn:
        for r in rows:
            conn.execute(
                """INSERT INTO crypto.derivatives (symbol, funding_rate, mark_price, open_interest_usd)
                   VALUES (%s,%s,%s,%s)""",
                (r["symbol"], r["funding_rate"], r["mark_price"], r["open_interest_usd"]),
            )
    return len(rows)
```

> Not: `collect_derivatives` her sembol için ayrı ayrı `try/except` içeriyor (Faz 1'deki `collect_markets`'in aksine) çünkü burada 17 ayrı API çağrısı var — biri başarısız olursa diğerlerini engellemeden devam etmesi gerekiyor. Bu, Faz 1 final review'ında bulunan "coupled error handling" dersinin burada baştan doğru uygulanmasıdır.

**Step 4: Testi tekrar çalıştır**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest test_collectors.py -v`
Expected: tüm testler (Faz 1 + yeni 2) PASS.

**Step 5: Canlı doğrulama**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -c "from collectors import collect_derivatives; print(collect_derivatives())"`
Expected: `17` (veya birkaç sembol başarısız olursa daha az — hata mesajları görünür ama çökme olmaz).

Run: `docker exec -i crypto-db psql -U crypto -d crypto -c "SELECT symbol, funding_rate, open_interest_usd FROM crypto.derivatives ORDER BY collected_at DESC LIMIT 5;"`
Expected: gerçek verilerle satırlar.

**Step 6: Commit**

```bash
cd ~/crypto-ingest && git add services/collectors.py services/test_collectors.py && git commit -m "feat(crypto): add derivatives collector (funding rate + open interest)"
```

---

### Task 2.3: Likidasyon dinleyici (`liquidation_listener.py`, arka plan thread'i)

**Files:**
- Create: `~/crypto-ingest/services/liquidation_listener.py`
- Create: `~/crypto-ingest/services/test_liquidation_listener.py`
- Modify: `~/crypto-ingest/requirements.txt` (`websockets` ekle)

**Step 1: Saf parse fonksiyonu için başarısız test yaz**

```python
# ~/crypto-ingest/services/test_liquidation_listener.py
from liquidation_listener import parse_force_order

def test_parse_force_order_maps_sell_to_long_liquidation():
    msg = {"e":"forceOrder","o":{"s":"BTCUSDT","S":"SELL","q":"0.014","ap":"9910"}}
    result = parse_force_order(msg)
    assert result == {"symbol": "BTC", "side": "long", "value_usd": 0.014 * 9910, "price_usd": 9910.0}

def test_parse_force_order_maps_buy_to_short_liquidation():
    msg = {"e":"forceOrder","o":{"s":"ETHUSDT","S":"BUY","q":"2.0","ap":"3000"}}
    result = parse_force_order(msg)
    assert result["side"] == "short"

def test_parse_force_order_returns_none_for_non_usdt_pair():
    msg = {"e":"forceOrder","o":{"s":"BTCBUSD","S":"SELL","q":"1","ap":"9910"}}
    assert parse_force_order(msg) is None
```

**Step 2: FAIL olduğunu doğrula**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest test_liquidation_listener.py -v`
Expected: `ModuleNotFoundError`.

**Step 3: Implementasyon**

```python
# ~/crypto-ingest/services/liquidation_listener.py
"""Binance !forceOrder@arr (keyless, public) - gercek zamanli likidasyon dinleyici.
Ana polling dongusunden bagimsiz, ayri bir arka plan thread'inde calisir."""
import asyncio
import json
import threading
import traceback

import websockets

from db import db

WS_URL = "wss://fstream.binance.com/ws/!forceOrder@arr"


def parse_force_order(msg: dict) -> dict | None:
    """Binance forceOrder mesajini crypto.liquidations satirina cevirir. USDT-M disi ciftleri atlar."""
    o = msg.get("o", {})
    symbol_raw = o.get("s", "")
    if not symbol_raw.endswith("USDT"):
        return None
    qty = float(o["q"])
    price = float(o["ap"])
    side = "long" if o.get("S") == "SELL" else "short"
    return {
        "symbol": symbol_raw[:-4],
        "side": side,
        "value_usd": qty * price,
        "price_usd": price,
    }


def _insert_liquidation(row: dict) -> None:
    with db() as conn:
        conn.execute(
            """INSERT INTO crypto.liquidations (symbol, side, value_usd, price_usd)
               VALUES (%s,%s,%s,%s)""",
            (row["symbol"], row["side"], row["value_usd"], row["price_usd"]),
        )


async def _listen_forever():
    while True:
        try:
            async with websockets.connect(WS_URL) as ws:
                print("[liquidations] connected", flush=True)
                async for raw in ws:
                    try:
                        msg = json.loads(raw)
                        row = parse_force_order(msg)
                        if row:
                            _insert_liquidation(row)
                            print(f"[liquidations] {row['symbol']} {row['side']} ${row['value_usd']:.0f}", flush=True)
                    except Exception:
                        traceback.print_exc()
        except Exception:
            print("[liquidations] connection lost, retrying in 5s", flush=True)
            traceback.print_exc()
            await asyncio.sleep(5)


def start_background_listener() -> threading.Thread:
    """Likidasyon dinleyiciyi ayri bir daemon thread'inde baslatir, thread nesnesini doner."""
    def _run():
        asyncio.run(_listen_forever())

    t = threading.Thread(target=_run, daemon=True, name="liquidation-listener")
    t.start()
    return t
```

**Step 4: Testi tekrar çalıştır**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest test_liquidation_listener.py -v`
Expected: 3 test PASS (bunlar saf fonksiyon testleri, websocket bağlantısı gerektirmez).

**Step 5: Canlı doğrulama (kısa süreli manuel çalıştırma)**

Run: `cd ~/crypto-ingest/services && timeout 20 ../.venv/bin/python -c "
from liquidation_listener import start_background_listener
import time
t = start_background_listener()
time.sleep(18)
"`
Expected: `[liquidations] connected` satırı görünür, hata yok (gerçek bir likidasyon 18sn içinde gelmeyebilir — bu normaldir, sadece bağlantının koptuğuna dair hata olmaması önemli).

**Step 6: `requirements.txt` güncelle ve commit**

```bash
cd ~/crypto-ingest
echo "websockets" >> requirements.txt
git add services/liquidation_listener.py services/test_liquidation_listener.py requirements.txt
git commit -m "feat(crypto): add real-time liquidation listener via Binance websocket"
```

---

### Task 2.4: Worker'a entegrasyon

**Files:**
- Modify: `~/crypto-ingest/services/worker.py`

**Step 1: worker.py'yi güncelle**

```python
# worker.py — mevcut dosyanin basina/icine ekleme
from collectors import collect_markets, collect_btc_whales, collect_eth_whales, collect_derivatives
from liquidation_listener import start_background_listener

INTERVALS = {
    "markets": 30,
    "whales": 120,
    "derivatives": 60,
}


def main():
    start_background_listener()  # likidasyonlar bagimsiz thread'de, INTERVALS dongusune dahil degil
    last_run = {k: 0.0 for k in INTERVALS}
    print("crypto-ingest worker started", flush=True)
    while True:
        now = time.monotonic()
        if now - last_run["markets"] >= INTERVALS["markets"]:
            try:
                n = collect_markets()
                print(f"[markets] {n} satir yazildi", flush=True)
            except Exception:
                traceback.print_exc()
            last_run["markets"] = now
        if now - last_run["whales"] >= INTERVALS["whales"]:
            b = 0
            try:
                b = collect_btc_whales()
            except Exception:
                traceback.print_exc()
            e = 0
            try:
                e = collect_eth_whales()
            except Exception:
                traceback.print_exc()
            print(f"[whales] BTC={b} ETH={e}", flush=True)
            last_run["whales"] = now
        if now - last_run["derivatives"] >= INTERVALS["derivatives"]:
            try:
                d = collect_derivatives()
                print(f"[derivatives] {d} satir yazildi", flush=True)
            except Exception:
                traceback.print_exc()
            last_run["derivatives"] = now
        time.sleep(5)
```

> Implementer notu: mevcut `worker.py` dosyasının tam güncel halini önce oku (Faz 1'deki whale try/except düzeltmesi zaten uygulanmış durumda), yukarıdaki değişiklikleri o gerçek dosyaya uygula — burada gösterilen tüm fonksiyon, sadece yeni eklenen parçaları netleştirmek için.

**Step 2: Elle kısa süre çalıştır**

Run: `cd ~/crypto-ingest/services && timeout 70 /home/ubuntu/crypto-ingest/.venv/bin/python worker.py`
Expected: `crypto-ingest worker started`, `[liquidations] connected`, `[markets] ...`, `[whales] ...` ve 60sn civarı `[derivatives] N satir yazildi` görünür.

**Step 3: systemd servisini yeniden başlat**

Run: `sudo systemctl restart crypto-ingest && sleep 10 && systemctl is-active crypto-ingest`
Expected: `active`

Run: `sudo journalctl -u crypto-ingest --no-pager -n 15`
Expected: dört toplayıcının da (markets/whales/derivatives/liquidations) loglarını gösterir, hata yok.

**Step 4: Commit**

```bash
cd ~/crypto-ingest && git add services/worker.py && git commit -m "feat(crypto): integrate derivatives collector and liquidation listener into worker"
```

---

### Task 2.5: Osiris `/api/crypto/derivatives` rotası

**Files:**
- Create: `~/osiris/src/app/api/crypto/derivatives/route.ts`
- Test: `~/osiris/src/app/api/crypto/derivatives/route.test.ts`

**Step 1: Başarısız test yaz**

```typescript
// ~/osiris/src/app/api/crypto/derivatives/route.test.ts
import { describe, it, expect } from 'vitest';
import { groupLatestBySymbol } from './route';

describe('groupLatestBySymbol (derivatives)', () => {
  it('keeps only the most recent row per symbol', () => {
    const rows = [
      { symbol: 'BTC', funding_rate: 0.0001, mark_price: 64000, open_interest_usd: 1000, collected_at: '2026-07-16T10:00:00Z' },
      { symbol: 'BTC', funding_rate: 0.0002, mark_price: 65000, open_interest_usd: 1100, collected_at: '2026-07-16T10:01:00Z' },
    ];
    const result = groupLatestBySymbol(rows as any);
    expect(result).toHaveLength(1);
    expect(result[0].funding_rate).toBe(0.0002);
  });
});
```

**Step 2: FAIL olduğunu doğrula**

Run: `cd ~/osiris && npx vitest run src/app/api/crypto/derivatives/route.test.ts`
Expected: FAIL, modül yok.

**Step 3: Implementasyon**

```typescript
// ~/osiris/src/app/api/crypto/derivatives/route.ts
import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface DerivativeRow {
  symbol: string;
  funding_rate: number | null;
  mark_price: number;
  open_interest_usd: number | null;
  collected_at: string;
}

export function groupLatestBySymbol(rows: DerivativeRow[]): DerivativeRow[] {
  const latest = new Map<string, DerivativeRow>();
  for (const row of rows) {
    const existing = latest.get(row.symbol);
    if (!existing || new Date(row.collected_at) > new Date(existing.collected_at)) {
      latest.set(row.symbol, row);
    }
  }
  return Array.from(latest.values());
}

export async function GET() {
  try {
    const db = getCryptoDb();
    const { rows } = await db.query<DerivativeRow>(
      `SELECT symbol, funding_rate, mark_price::float8 AS mark_price,
              open_interest_usd::float8 AS open_interest_usd, collected_at
       FROM crypto.derivatives
       WHERE collected_at > now() - interval '20 minutes'
       ORDER BY collected_at DESC`
    );
    const derivatives = groupLatestBySymbol(rows);
    return NextResponse.json(
      { derivatives, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/derivatives fetch error:', error);
    return NextResponse.json({ derivatives: [], error: 'Failed' }, { status: 500 });
  }
}
```

> Not: `mark_price`/`open_interest_usd` `NUMERIC` tipinde olduğu için (Faz 1'in dersi) `::float8` cast edildi. `funding_rate` `REAL` olduğundan node-pg zaten number döner, cast gerekmez.

**Step 4-6: Test, build, doğrulama, commit** (Faz 1 Task 1.5/1.6 ile birebir aynı kalıp)

Run: `cd ~/osiris && npx vitest run src/app/api/crypto/derivatives/route.test.ts` → PASS
Run: `npm run build && pm2 restart osiris && curl -s http://localhost:3000/api/crypto/derivatives | head -c 300` → gerçek veri
Run: `git add src/app/api/crypto/derivatives/ && git commit -m "feat(crypto): add derivatives API route"`

---

### Task 2.6: Osiris `/api/crypto/liquidations` rotası

**Files:**
- Create: `~/osiris/src/app/api/crypto/liquidations/route.ts`
- Test: `~/osiris/src/app/api/crypto/liquidations/route.test.ts`

**Step 1: Başarısız test yaz**

```typescript
// ~/osiris/src/app/api/crypto/liquidations/route.test.ts
import { describe, it, expect } from 'vitest';
import { formatLiquidation } from './route';

describe('formatLiquidation', () => {
  it('rounds value_usd to nearest dollar', () => {
    const row = { symbol: 'BTC', side: 'long', value_usd: 138.678, price_usd: 9910.5, observed_at: '2026-07-16T10:00:00Z' };
    expect(formatLiquidation(row as any).value_usd).toBe(139);
  });
});
```

**Step 2-3: FAIL, sonra implementasyon**

```typescript
// ~/osiris/src/app/api/crypto/liquidations/route.ts
import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface LiquidationRow {
  symbol: string;
  side: string;
  value_usd: number;
  price_usd: number;
  observed_at: string;
}

export function formatLiquidation(row: LiquidationRow): LiquidationRow {
  return { ...row, value_usd: Math.round(row.value_usd) };
}

export async function GET() {
  try {
    const db = getCryptoDb();
    const { rows } = await db.query<LiquidationRow>(
      `SELECT symbol, side, value_usd::float8 AS value_usd, price_usd::float8 AS price_usd, observed_at
       FROM crypto.liquidations
       WHERE observed_at > now() - interval '1 hour'
       ORDER BY observed_at DESC
       LIMIT 100`
    );
    return NextResponse.json(
      { liquidations: rows.map(formatLiquidation), timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/liquidations fetch error:', error);
    return NextResponse.json({ liquidations: [], error: 'Failed' }, { status: 500 });
  }
}
```

**Step 4-6:** Aynı Faz 1 kalıbı — test PASS, build+restart, curl doğrula, commit (`feat(crypto): add liquidations API route`).

---

### Task 2.7: Tam test paketi + regresyon doğrulama

**Step 1:** `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest -v` → tüm testler PASS
**Step 2:** `cd ~/osiris && npm test` → tüm testler PASS, regresyon yok
**Step 3:** `curl -s -o /dev/null -w "HTTP %{http_code}\n" https://globe.coinhit.net` → 200
**Step 4:** `curl -s https://globe.coinhit.net/api/crypto/derivatives | head -c 200` ve `/liquidations` → gerçek veri
**Step 5:** `systemctl is-active crypto-ingest` → active, `journalctl -u crypto-ingest -n 20` → dört toplayıcı da çalışıyor, hata yok

**Faz 2 tamamlandı.**
