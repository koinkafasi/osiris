# CoinHit Kripto İstihbarat Katmanı — Faz 4: Sinyal Bus + Entegrasyonlar

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task.

**Goal:** Toplanan kripto verisinden eşik-bazlı önemli olaylar ("sinyal") üretmek, bunları Redis pub/sub + `crypto.signals` tablosuna yazmak, kimlik doğrulamalı bir Osiris rotasıyla iç kullanıma açmak ve Pythia'nın tahmin motoruna gerçek entegrasyon kurmak.

**Architecture:** `crypto-ingest`'e yeni bir `signals.py` — worker'ın topladığı taze veriyi (whale, derivatives, liquidations, compliance, defi/stablecoin) periyodik tarayıp eşik aşımlarını `crypto.signals`'a yazar ve yeni bir `crypto-redis` container'ına PUBLISH eder. Osiris'te kimlik doğrulamalı `/api/crypto/signals` rotası. Pythia'nın **zaten var olan** genel Osiris-feed-alma mekanizmasına (`osiris_intake.py`, `FEEDS` listesi) yeni kripto rotaları eklenir — bu, orijinal taslağın öngördüğü "yeni bir consumer yaz" yerine, mevcut, çalışan bir uzatma noktasını kullanan çok daha temiz bir entegrasyon.

**Tech Stack:** Redis 7 (yeni `crypto-redis` container), Python (worker + Pythia'nın mevcut `osiris_intake.py`), Next.js/TypeScript (Osiris rotası), pytest, vitest.

**Referans:** Faz 1-3 planları. Bu fazda **mimari düzeltme** var — aşağıdaki "Ortam Notları"nı mutlaka oku.

---

## ⚠️ Ortam Notları — Faz 4'e özel kritik keşifler ve kapsam düzeltmesi

- **`coinhit-engine` (içerik motoru) hâlâ yok / repurpose edilmiş durumda** (Faz 1 başındaki göç, bkz. ana plan dokümanının "Mimari Revizyonu" notu). Gerçek içerik pipeline'ı artık uzak bir sunucuda (173.249.30.38) ve bu makineden **erişilebilir bir köprü/API/webhook yok** (bu oturumda araştırıldı, doğrulandı — bkz. Faz 1 sonundaki araştırma bulguları). **Karar:** "İçerik motoru entegrasyonu" görevi, orijinal taslağın öngördüğü gibi bir `crypto_signal_subscriber.py` (uzak/yok olan `pipeline.articles`'a yazan) **KURULAMAZ**. Bunun yerine kapsam şuna indirgendi: sinyalleri Redis'e **PUBLISH etmek** (tüketici tarafı gelecekte bir köprü kurulduğunda kolayca eklenebilir bir "yayın noktası" bırakmak) — bu, kullanıcının "büyük bir sunucuya taşımak istersem" hedefiyle de örtüşüyor. Gerçek uzak-tüketici entegrasyonu bu fazın kapsamı dışında, açıkça belgelenmiş bir sınır.
- **Pythia CANLI ve ERİŞİLEBİLİR** — orijinal taslağın aksine bu bir sorun değil. `pythia-oracle.service` aktif (port 8088), ama **domain değişmiş**: artık `pythia.coinhit.net` değil, **`world.coinhit.net`**. `~/pythia-project/engine/osiris_intake.py` (505 satır) zaten genel bir Osiris-feed-alma mekanizması içeriyor:
  - `FEEDS` listesi: `(api_yolu, kaynak_adi, kategori)` üçlüleri — 30+ mevcut Osiris rotası zaten burada (`/api/gdelt`, `/api/news`, eski `/api/crypto` dahil).
  - `_fetch_feed()` her kaynağı adına göre özel bir normalize fonksiyonuna yönlendirir (örn. `_markets_events`, `_gdacs_events`) veya genel `_to_event()`'e düşer.
  - **Önemli:** eski `("/api/crypto", "crypto", "markets")` girişi, `_markets_events()`'i kullanıyor — o fonksiyon `{isim: {price, change_percent}}` şeklinde **gruplu bir dict** bekliyor. Bizim yeni `/api/crypto/markets` rotamızın şekli tamamen farklı: `{markets: [{symbol, price_usd, change_24h_pct, ...}], timestamp}` — **dizi**. Bu yüzden yeni rotalarımız için **yeni normalize fonksiyonları** yazılmalı, eski `_markets_events` yeniden kullanılamaz. Eski `/api/crypto` girişi dokunulmadan kalabilir (geriye dönük uyumluluk, YAGNI — kaldırmaya gerek yok).
  - **Karar:** Pythia entegrasyonu, `osiris_intake.py`'ye yeni `FEEDS` girişleri + yeni normalize fonksiyonları eklemek şeklinde yapılacak — bu, orijinal taslağın "ayrı bir consumer modülü yaz" fikrinden çok daha az riskli ve mevcut, test edilmiş bir mekanizmayı kullanıyor.
- **Redis portu**: `6380` zaten **FalkorDB** (Graphiti hafıza sistemi) tarafından kullanılıyor — `crypto-redis` için **`6381`** kullanılacak (bu oturumda boş olduğu doğrulandı).
- **Osiris auth deseni**: Mevcut `src/app/api/sdk/ingest/route.ts`, `SDK_KEY` env değişkeninden türeyen bir `VALID_KEYS` seti kullanıyor ama bu POST body içinde `apiKey` alanı bekliyor (GET'e uygun değil). `/api/crypto/signals` bir GET rotası olduğundan, standart `Authorization: Bearer <token>` header kontrolü kullanılacak (aynı "env değişkeninden türeyen anahtar" felsefesiyle, ama GET'e uygun HTTP konvansiyonuyla).

---

## FAZ 4 — Görevler (tam TDD detayı)

### Task 4.1: `crypto.signals` şeması + `crypto-redis` container

**Files:**
- Create: `~/crypto-ingest/db/phase4_schema.sql`
- Modify: `~/crypto-ingest/docker-compose.yml`
- Modify: `~/crypto-ingest/.env` (yeni `CRYPTO_REDIS_URL`)

**Step 1: Şema**

```sql
-- CoinHit Kripto İstihbarat Katmanı — Faz 4: sinyal şeması
CREATE TABLE IF NOT EXISTS crypto.signals (
  id SERIAL PRIMARY KEY,
  signal_type TEXT NOT NULL,     -- 'whale_alert' | 'funding_extreme' | 'liquidation_cascade' | 'compliance_hit' | 'tvl_drop' | 'stablecoin_depeg'
  severity TEXT NOT NULL,        -- 'info' | 'warning' | 'critical'
  symbol TEXT,
  message TEXT NOT NULL,
  payload JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS signals_time_idx ON crypto.signals (created_at DESC);
CREATE INDEX IF NOT EXISTS signals_type_time_idx ON crypto.signals (signal_type, created_at DESC);
```

Run: `docker exec -i crypto-db psql -U crypto -d crypto < ~/crypto-ingest/db/phase4_schema.sql`
Expected: `CREATE TABLE`, `CREATE INDEX` x2.

**Step 2: `docker-compose.yml`'e redis ekle**

Mevcut dosyayı oku, `services:` altına şunu ekle (mevcut `crypto-db` servisinin yanına, `volumes:` bölümünü güncelle):

```yaml
  crypto-redis:
    image: redis:7-alpine
    container_name: crypto-redis
    restart: unless-stopped
    ports:
      - "127.0.0.1:6381:6379"
    volumes:
      - crypto_redis_data:/data
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 10
```

`volumes:` bloğuna `crypto_redis_data:` ekle.

**Step 3: Başlat ve doğrula**

Run: `cd ~/crypto-ingest && docker compose up -d crypto-redis && sleep 5 && docker exec crypto-redis redis-cli ping`
Expected: `PONG`

**Step 4: `.env`'e ekle, `requirements.txt`'e `redis` ekle, kur**

```
CRYPTO_REDIS_URL=redis://127.0.0.1:6381/0
```

Run: `cd ~/crypto-ingest && echo redis >> requirements.txt && /home/ubuntu/.local/bin/uv pip install --python .venv/bin/python redis`

**Step 5: Commit**

```bash
cd ~/crypto-ingest && git add db/phase4_schema.sql docker-compose.yml requirements.txt && git commit -m "feat(crypto): add signals schema and dedicated crypto-redis container"
```
(`.env` gitignored, elle güncellenir — implementer commit'e dahil etmesin.)

---

### Task 4.2: Sinyal kural motoru (`signals.py`)

**Files:**
- Create: `~/crypto-ingest/services/signals.py`
- Create: `~/crypto-ingest/services/test_signals.py`

**Step 1: Başarısız testler yaz**

```python
# ~/crypto-ingest/services/test_signals.py
from signals import evaluate_whale, evaluate_funding_extreme, evaluate_liquidation_cascade

def test_evaluate_whale_flags_above_threshold():
    txn = {"chain": "BTC", "tx_hash": "abc", "value_usd": 1_500_000, "to_address": "bc1..."}
    sig = evaluate_whale(txn, threshold_usd=1_000_000)
    assert sig is not None
    assert sig["signal_type"] == "whale_alert"
    assert sig["severity"] == "warning"

def test_evaluate_whale_ignores_below_threshold():
    txn = {"chain": "BTC", "tx_hash": "abc", "value_usd": 600_000, "to_address": "bc1..."}
    assert evaluate_whale(txn, threshold_usd=1_000_000) is None

def test_evaluate_funding_extreme_flags_high_rate():
    row = {"symbol": "BTC", "funding_rate": 0.003, "mark_price": 65000}  # %0.3, asiri yuksek
    sig = evaluate_funding_extreme(row, threshold=0.001)
    assert sig is not None
    assert sig["severity"] == "warning"

def test_evaluate_funding_extreme_ignores_normal_rate():
    row = {"symbol": "BTC", "funding_rate": 0.0001, "mark_price": 65000}
    assert evaluate_funding_extreme(row, threshold=0.001) is None

def test_evaluate_liquidation_cascade_flags_cluster():
    liqs = [{"symbol": "BTC", "value_usd": 200_000} for _ in range(6)]
    sig = evaluate_liquidation_cascade(liqs, count_threshold=5, symbol="BTC")
    assert sig is not None
    assert sig["signal_type"] == "liquidation_cascade"

def test_evaluate_liquidation_cascade_ignores_few():
    liqs = [{"symbol": "BTC", "value_usd": 200_000} for _ in range(2)]
    assert evaluate_liquidation_cascade(liqs, count_threshold=5, symbol="BTC") is None
```

**Step 2: FAIL olduğunu doğrula**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest test_signals.py -v`
Expected: `ImportError`.

**Step 3: Implementasyon**

```python
# ~/crypto-ingest/services/signals.py
"""Esik-bazli sinyal kural motoru. Her fonksiyon SAF: girdi -> sinyal dict | None.
DB/redis yazma islemleri check_and_emit_signals() icinde, ayri bir katmanda."""
import json
import os

import redis as redis_lib

from db import db

WHALE_SIGNAL_THRESHOLD_USD = 1_000_000
FUNDING_EXTREME_THRESHOLD = 0.001       # %0.1 - Binance perpetual icin yuksek sayilir
LIQUIDATION_CASCADE_COUNT = 5           # ayni sembolde art arda N likidasyon
LIQUIDATION_CASCADE_WINDOW_MIN = 5

_redis_client = None


def _redis():
    global _redis_client
    if _redis_client is None:
        _redis_client = redis_lib.from_url(os.environ["CRYPTO_REDIS_URL"], decode_responses=True)
    return _redis_client


def evaluate_whale(txn: dict, threshold_usd: float = WHALE_SIGNAL_THRESHOLD_USD) -> dict | None:
    if txn["value_usd"] < threshold_usd:
        return None
    return {
        "signal_type": "whale_alert",
        "severity": "critical" if txn["value_usd"] >= threshold_usd * 5 else "warning",
        "symbol": txn["chain"],
        "message": f"{txn['chain']} whale transfer: ${txn['value_usd']:,.0f} -> {txn.get('to_address', '?')[:16]}...",
        "payload": {"tx_hash": txn["tx_hash"], "value_usd": txn["value_usd"]},
    }


def evaluate_funding_extreme(row: dict, threshold: float = FUNDING_EXTREME_THRESHOLD) -> dict | None:
    rate = row.get("funding_rate")
    if rate is None or abs(rate) < threshold:
        return None
    return {
        "signal_type": "funding_extreme",
        "severity": "warning",
        "symbol": row["symbol"],
        "message": f"{row['symbol']} funding rate extreme: {rate*100:.3f}%",
        "payload": {"funding_rate": rate, "mark_price": row.get("mark_price")},
    }


def evaluate_liquidation_cascade(recent_liqs: list[dict], count_threshold: int = LIQUIDATION_CASCADE_COUNT, symbol: str | None = None) -> dict | None:
    if len(recent_liqs) < count_threshold:
        return None
    total_usd = sum(l["value_usd"] for l in recent_liqs)
    sym = symbol or recent_liqs[0].get("symbol", "?")
    return {
        "signal_type": "liquidation_cascade",
        "severity": "critical",
        "symbol": sym,
        "message": f"{sym} liquidation cascade: {len(recent_liqs)} events, ${total_usd:,.0f} total",
        "payload": {"count": len(recent_liqs), "total_usd": total_usd},
    }


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


def check_and_emit_signals() -> int:
    """Son verileri tarar, esik asimlarini crypto.signals'a yazar + redis'e publish eder.
    Yazilan sinyal sayisini doner."""
    emitted = []
    with db() as conn:
        whales = conn.execute(
            "SELECT chain, tx_hash, value_usd, to_address FROM crypto.whale_txns WHERE observed_at > now() - interval '5 minutes'"
        ).fetchall()
        for chain, tx_hash, value_usd, to_address in whales:
            sig = evaluate_whale({"chain": chain, "tx_hash": tx_hash, "value_usd": float(value_usd), "to_address": to_address})
            if sig:
                emitted.append(sig)

        derivs = conn.execute(
            "SELECT DISTINCT ON (symbol) symbol, funding_rate, mark_price FROM crypto.derivatives ORDER BY symbol, collected_at DESC"
        ).fetchall()
        for symbol, funding_rate, mark_price in derivs:
            if funding_rate is None:
                continue
            sig = evaluate_funding_extreme({"symbol": symbol, "funding_rate": float(funding_rate), "mark_price": mark_price})
            if sig:
                emitted.append(sig)

        liq_rows = conn.execute(
            "SELECT symbol, value_usd FROM crypto.liquidations WHERE observed_at > now() - interval '5 minutes' ORDER BY symbol"
        ).fetchall()
        by_symbol: dict[str, list[dict]] = {}
        for symbol, value_usd in liq_rows:
            by_symbol.setdefault(symbol, []).append({"symbol": symbol, "value_usd": float(value_usd)})
        for symbol, liqs in by_symbol.items():
            sig = evaluate_liquidation_cascade(liqs, symbol=symbol)
            if sig:
                emitted.append(sig)

    for sig in emitted:
        _emit(sig)
    return len(emitted)
```

> Not: `compliance_hit` sinyali ayrıca eklenmiyor çünkü `collect_compliance()` zaten `crypto.compliance_hits`'e yazıyor (Faz 3) — implementer isterse `check_and_emit_signals()`'a bir `compliance` bloğu daha ekleyip her yeni `compliance_hits` satırı için otomatik `critical` sinyal üretebilir (aynı desen). `tvl_drop`/`stablecoin_depeg` de benzer şekilde genişletilebilir ama Faz 4'ün ilk sürümü için üç tip (whale/funding/liquidation) yeterli — YAGNI, gerekirse sonra eklenir.

**Step 4: Test PASS**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest test_signals.py -v`

**Step 5: Canlı doğrulama**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -c "from signals import check_and_emit_signals; print(check_and_emit_signals())"`
Expected: hata yok, 0 veya daha fazla (gerçek veri eşiği aşmayabilir, normal).

Run: `docker exec -i crypto-db psql -U crypto -d crypto -c "SELECT signal_type, severity, message FROM crypto.signals ORDER BY created_at DESC LIMIT 5;"`

**Step 6: Commit**

```bash
cd ~/crypto-ingest && git add services/signals.py services/test_signals.py && git commit -m "feat(crypto): add threshold-based signal rule engine with redis publish"
```

---

### Task 4.3: Worker entegrasyonu

**Files:**
- Modify: `~/crypto-ingest/services/worker.py`

Mevcut dosyayı oku (Faz 1-3'ün tüm düzeltmeleri dahil — whale try/except ayrımı, listener liveness check, 8 toplayıcı). `INTERVALS`'e `"signals": 60` ekle, `from signals import check_and_emit_signals` import et, ana döngüye kendi try/except'i ile bir blok ekle.

Manuel test → systemd restart → `journalctl` doğrulama (9. toplayıcı olarak `[signals] N sinyal yazildi` görünmeli) → commit (`feat(crypto): integrate signal engine into worker`).

---

### Task 4.4: Osiris `/api/crypto/signals` rotası (kimlik doğrulamalı)

**Files:**
- Create: `~/osiris/src/app/api/crypto/signals/route.ts` + test
- Modify: `~/osiris/.env`, `.env.example` (`CRYPTO_SIGNALS_API_KEY` ekle)

**Step 1: Başarısız test yaz** (yetkilendirme mantığı için saf fonksiyon)

```typescript
// ~/osiris/src/app/api/crypto/signals/route.test.ts
import { describe, it, expect } from 'vitest';
import { isAuthorized } from './route';

describe('isAuthorized', () => {
  it('accepts a matching bearer token', () => {
    expect(isAuthorized('Bearer secret123', 'secret123')).toBe(true);
  });
  it('rejects a missing header', () => {
    expect(isAuthorized(null, 'secret123')).toBe(false);
  });
  it('rejects a wrong token', () => {
    expect(isAuthorized('Bearer wrong', 'secret123')).toBe(false);
  });
});
```

**Step 2-3: FAIL, implementasyon**

```typescript
// ~/osiris/src/app/api/crypto/signals/route.ts
import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface SignalRow {
  signal_type: string;
  severity: string;
  symbol: string | null;
  message: string;
  payload: unknown;
  created_at: string;
}

export function isAuthorized(authHeader: string | null, expectedKey: string): boolean {
  if (!authHeader) return false;
  const match = authHeader.match(/^Bearer\s+(.+)$/);
  return !!match && match[1] === expectedKey;
}

export async function GET(req: Request) {
  const expectedKey = process.env.CRYPTO_SIGNALS_API_KEY;
  if (!expectedKey) {
    return NextResponse.json({ error: 'Signals API not configured' }, { status: 503 });
  }
  if (!isAuthorized(req.headers.get('authorization'), expectedKey)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    const db = getCryptoDb();
    const { rows } = await db.query<SignalRow>(
      `SELECT signal_type, severity, symbol, message, payload, created_at
       FROM crypto.signals
       WHERE created_at > now() - interval '24 hours'
       ORDER BY created_at DESC
       LIMIT 100`
    );
    return NextResponse.json(
      { signals: rows, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/signals fetch error:', error);
    return NextResponse.json({ signals: [], error: 'Failed' }, { status: 500 });
  }
}
```

`payload` `JSONB` — node-pg zaten JS objesi olarak döner, cast gerekmez.

`.env.example`'a ekle: `CRYPTO_SIGNALS_API_KEY=changeme` — implementer `.env`'e rastgele güvenli bir değer üretip yazsın (`openssl rand -hex 24`), crypto-ingest'in `.env`'ine de **aynı değeri** (redis publish eden taraf ile tüketen taraf arasında paylaşılan sır değil, sadece Osiris rotasını korumak için — crypto-ingest'in bu anahtara ihtiyacı yok, sadece Osiris'in dış dünyaya karşı kendini koruması için).

**Step 4-6:** Test PASS → build+restart → `curl -H "Authorization: Bearer <key>" http://localhost:3000/api/crypto/signals` (401'siz) VE `curl http://localhost:3000/api/crypto/signals` (401 bekleniyor — auth çalışıyor mu doğrula) → commit (`feat(crypto): add authenticated signals API route`).

---

### Task 4.5: Pythia entegrasyonu (`osiris_intake.py` genişletme)

**Files:**
- Modify: `~/pythia-project/engine/osiris_intake.py`

**Step 1: Mevcut dosyayı oku**

Implementer `~/pythia-project/engine/osiris_intake.py`'yi (505 satır) baştan sona okusun — özellikle `FEEDS` listesi (satır ~20-45), `_markets_events` (satır ~152), `_fetch_feed` dispatch mantığı (satır ~436) ve `WorldEvent` modelinin tanımı (`engine/models.py`).

**Step 2: `FEEDS` listesine yeni girişler ekle**

```python
# FEEDS listesine ekle (mevcut ("/api/crypto", "crypto", "markets") satırının yanına):
("/api/crypto/markets", "crypto-markets", "markets"),
("/api/crypto/whales", "crypto-whales", "markets"),
("/api/crypto/derivatives", "crypto-derivatives", "markets"),
("/api/crypto/liquidations", "crypto-liquidations", "markets"),
```

**Step 3: Yeni normalize fonksiyonları yaz**

```python
def _crypto_markets_events(data: dict) -> list[WorldEvent]:
    """Yeni /api/crypto/markets: {markets: [{symbol, price_usd, change_24h_pct, ...}]}."""
    out: list[WorldEvent] = []
    for m in data.get("markets", []):
        chg = m.get("change_24h_pct")
        if chg is None or abs(chg) < 3:  # sadece anlamli hareketleri sinyal olarak ver
            continue
        sign = "+" if chg >= 0 else ""
        title = f"{m['symbol']}: ${m.get('price_usd')} ({sign}{chg:.1f}%)"
        out.append(WorldEvent(title=title[:120], category="markets", source="crypto-markets",
                              salience=min(1.0, 0.4 + abs(chg) / 20)))
    return out


def _crypto_whales_events(data: dict) -> list[WorldEvent]:
    out: list[WorldEvent] = []
    for w in data.get("whales", [])[:10]:
        title = f"{w['chain']} whale transfer: ${w.get('value_usd', 0):,.0f}"
        out.append(WorldEvent(title=title[:120], category="markets", source="crypto-whales",
                              salience=min(1.0, 0.5 + (w.get("value_usd", 0) / 10_000_000))))
    return out


def _crypto_derivatives_events(data: dict) -> list[WorldEvent]:
    out: list[WorldEvent] = []
    for d in data.get("derivatives", []):
        rate = d.get("funding_rate")
        if rate is None or abs(rate) < 0.0008:
            continue
        title = f"{d['symbol']} funding rate: {rate*100:.3f}%"
        out.append(WorldEvent(title=title[:120], category="markets", source="crypto-derivatives",
                              salience=min(1.0, 0.4 + abs(rate) * 200)))
    return out


def _crypto_liquidations_events(data: dict) -> list[WorldEvent]:
    out: list[WorldEvent] = []
    for l in data.get("liquidations", [])[:10]:
        title = f"{l['symbol']} {l['side']} liquidation: ${l.get('value_usd', 0):,.0f}"
        out.append(WorldEvent(title=title[:120], category="markets", source="crypto-liquidations",
                              salience=min(1.0, 0.5 + (l.get("value_usd", 0) / 5_000_000))))
    return out
```

**Step 4: `_fetch_feed` dispatch'ine ekle**

```python
# _fetch_feed icindeki if/elif zincirine ekle (mevcut "if source in ('markets','crypto')" satirindan sonra):
elif source == "crypto-markets":
    out.extend(_crypto_markets_events(data))
elif source == "crypto-whales":
    out.extend(_crypto_whales_events(data))
elif source == "crypto-derivatives":
    out.extend(_crypto_derivatives_events(data))
elif source == "crypto-liquidations":
    out.extend(_crypto_liquidations_events(data))
```

**Step 5: Doğrula**

Pythia için mevcut bir test altyapısı varsa (implementer kontrol etsin — `pythia-project` içinde `tests/` ara), aynı kalıpta bir test eklensin. Yoksa (muhtemel — bu proje farklı bir test kültürüne sahip olabilir), en azından manuel doğrulama yeterli:

Run: `cd ~/pythia-project && python3 -c "
import asyncio
from engine.osiris_intake import OsirisIntake
async def test():
    intake = OsirisIntake()
    events = await intake.fetch(limit=50)
    crypto_events = [e for e in events if e.source.startswith('crypto-')]
    print(f'{len(crypto_events)} kripto event bulundu')
    for e in crypto_events[:5]:
        print(f'  {e.source}: {e.title}')
asyncio.run(test())
"`
Expected: hata yok, birkaç kripto event listelenir (veya piyasa hareketleri eşiğin altındaysa 0 — normal).

**Not:** `pythia-oracle.service` çalışıyorsa bu değişiklik sonrası **yeniden başlatılması gerekip gerekmediğini implementer değerlendirsin** — servisin `osiris_intake.py`'yi her döngüde yeniden mi import ettiği yoksa process başlangıcında mı yüklediği önemli. Eğer process-lifetime'da bir kez yükleniyorsa, `sudo systemctl restart pythia-oracle` gerekir; bu **başka bir canlı servisi etkileyen bir işlem**, dikkatli yapılmalı (Osiris/crypto-ingest'e paralel, ayrı bir servis — bizim crypto katmanımızın sağlığını etkilemez ama Pythia'nın kendi sağlığını etkileyebilir, restart öncesi/sonrası `systemctl is-active pythia-oracle` ile doğrulanmalı).

**Step 6: Commit**

```bash
cd ~/pythia-project && git add engine/osiris_intake.py && git commit -m "feat: ingest CoinHit crypto intelligence feeds (markets/whales/derivatives/liquidations)"
```

> Not: `pythia-project` reposunun git durumu (branch, remote) bu görev başlamadan önce implementer tarafından kontrol edilmeli (`git status`, `git branch`) — bu proje, bu planın diğer görevlerinin çalıştığı `crypto-ingest`/`osiris` repolarından tamamen ayrı, üçüncü bir repo.

---

### Task 4.6: İçerik motoru köprüsü (yalnızca yayın tarafı — belgelenmiş sınır)

**Files:**
- Modify: `~/crypto-ingest/README.md`

Bu görev kod yazmaz — Faz 4'ün "içerik motoru entegrasyonu" parçasının neden tam kapsamda yapılamadığını ve gelecekte nasıl tamamlanacağını `README.md`'ye ekler:

```markdown
## İçerik Motoru Köprüsü (Faz 4 — kısmi, belgelenmiş sınır)

`crypto.signals` tablosu ve `crypto.signals` Redis kanalı (`crypto-redis`, 127.0.0.1:6381)
zaten YAYINLIYOR — her yeni sinyal hem DB'ye yazılıyor hem redis PUBLISH ediliyor.

CoinHit'in içerik üretim pipeline'ı (eski `coinhit-engine`) 2026-07 sunucu göçü sırasında
uzak bir sunucuya taşındı; bu makineden o pipeline'a erişim/köprü şu an YOK (araştırıldı,
doğrulandı — bkz. `docs/plans/2026-07-13-crypto-intelligence-layer.md`'nin göç notları).

**Gelecekte tüketici tarafını kurmak için:** uzak sunucuda `redis SUBSCRIBE crypto.signals`
yapan küçük bir Python scripti yeterli olacak — bu makinenin `crypto-redis`'i şu an sadece
localhost'a bağlı (127.0.0.1:6381), uzak erişim için ya SSH tüneli ya da güvenlik grubu
açılıp public bind gerekecek. Bu, ayrı bir altyapı kararı, bu planın kapsamında değil.
```

Run: `cd ~/crypto-ingest && git add README.md && git commit -m "docs(crypto): document content-engine bridge boundary (publish-only, no remote consumer)"`

---

### Task 4.7: Tam test paketi + regresyon doğrulama

**Step 1:** `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest -v` → tüm testler PASS
**Step 2:** `cd ~/osiris && npm test` → tüm testler PASS
**Step 3:** `curl -s -o /dev/null -w "HTTP %{http_code}\n" https://globe.coinhit.net` → 200
**Step 4:** `curl -s https://globe.coinhit.net/api/crypto/signals` → 401 (auth olmadan) — doğru davranış
**Step 5:** `systemctl is-active crypto-ingest` → active, `journalctl -u crypto-ingest -n 30` → 9 toplayıcının hepsi (markets/whales/derivatives/liquidations/defi/stablecoins/geo/compliance/**signals**) çalışıyor
**Step 6:** `docker exec crypto-redis redis-cli ping` → PONG
**Step 7:** `systemctl is-active pythia-oracle` → active (bozulmadı)

**Faz 4 tamamlandı.**
