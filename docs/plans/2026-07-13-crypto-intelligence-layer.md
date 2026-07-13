# CoinHit Kripto İstihbarat Katmanı — Uygulama Planı

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Osiris'in kripto modülünü, halka açık panoyu (globe.coinhit.net), Pythia'yı, coinhit-engine içerik motorunu ve iç sinyalleri besleyen merkezi bir kripto istihbarat katmanına dönüştürmek.

**Architecture:** Python worker (`coinhit-engine/services/crypto_ingest/`) dış kaynaklardan (Binance, on-chain, DefiLlama, OFAC) veri toplar, mevcut `coinhit` postgres'inde yeni `crypto` şemasına yazar. Osiris (Next.js, PM2 ile çalışıyor) bu şemayı okuyan API rotaları sunar; küre UI bu rotalardan beslenir. Pythia ve coinhit-engine aynı rotaları/şemayı tüketir. Redis pub/sub yalnızca Faz 4'te (sinyal bus) eklenir — Faz 1-3 için gerekli değil (YAGNI).

**Tech Stack:** Python 3.11 (worker, coinhit-engine `.venv`, psycopg3), PostgreSQL 16/pgvector (mevcut `coinhit-pipeline-db`, 127.0.0.1:5433), Next.js 16 / TypeScript (Osiris API rotaları), `pg` npm paketi (yeni), systemd (worker servisi), vitest (Osiris testleri), pytest (worker testleri).

**Referans:** Tasarım dokümanı — `docs/plans/2026-07-13-crypto-intelligence-layer-design.md`

---

## Ortam Notları (bir engineer'ın bilmesi gerekenler)

- **Osiris** (`~/osiris`) PM2 ile çalışıyor (`pm2 list` → `osiris`), `next start`, port 3000. Kod değişikliğinden sonra: `npm run build && pm2 restart osiris`.
- **coinhit-engine** (`~/coinhit-engine`) servisleri systemd ile yönetiliyor: sürekli servisler `Type=simple, Restart=always` (örn. `coinhit-enricher.service`), periyodik işler `Type=oneshot` + `.timer` (örn. `coinhit-curator.service/.timer`). Python venv: `~/coinhit-engine/.venv`.
- **Postgres**: `coinhit-pipeline-db` container, db=`coinhit`, `127.0.0.1:5433`, şifre `PIPELINE_DB_PASSWORD` env'de (`~/coinhit-engine/.env`). Bağlantı: `DATABASE_URL=postgresql://coinhit:***@127.0.0.1:5433/coinhit`. Şema kalıbı: her alan kendi şeması (`news`, `pipeline`, şimdi `crypto`).
- **`coinhit-engine/services/common.py`** zaten `db()` (psycopg autocommit connection) ve `RateLimitedClient` (rate-limit + postgres cache + backoff) sağlıyor — worker bunu import edip yeniden kullanacak.
- **Osiris testleri**: `*.test.ts` kaynak dosyasının yanında, `vitest run` ile çalışır. Dış ağ gerektiren testler `RUN_LIVE_TESTS=1 vitest run` ile opsiyonel — bkz. `src/app/api/cctv/utah.test.ts` örneği (saf fonksiyonlar test edilir, canlı fetch ayrı gate'lenir).
- **Redis**: Şu an dedicated bir redis yok; `social_redis_1` var ama izole `social_internal_network`'te, paylaşmak gereksiz karmaşıklık katar. Faz 4'te `crypto-redis` adında yeni, küçük bir redis container'ı `coinhit-engine_default` ağına eklenecek (port 6380, host-only).

---

## FAZ 1 — Piyasa + Balina Takibi (tam TDD detayı)

### Task 1.1: `crypto` postgres şeması

**Files:**
- Create: `~/coinhit-engine/db/crypto_schema.sql`
- Modify: `~/coinhit-engine/db/init.sql` (sonuna `\i crypto_schema.sql` benzeri not eklenmez; şema dosyası ayrı çalıştırılır — bkz. Step 2)

**Step 1: Şema dosyasını yaz**

```sql
-- CoinHit Kripto İstihbarat Katmanı — crypto şeması (Faz 1: piyasa + balina)
CREATE SCHEMA IF NOT EXISTS crypto;

CREATE TABLE IF NOT EXISTS crypto.markets (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,              -- 'BTC', 'ETH', ...
  price_usd NUMERIC(20,8) NOT NULL,
  volume_24h_usd NUMERIC(24,2),
  change_24h_pct REAL,
  btc_dominance_pct REAL,            -- global metrik, her satırda tekrarlanır (basit sorgu için)
  fear_greed_index INT,              -- 0-100, global metrik
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS markets_symbol_time_idx ON crypto.markets (symbol, collected_at DESC);

CREATE TABLE IF NOT EXISTS crypto.whale_txns (
  id SERIAL PRIMARY KEY,
  chain TEXT NOT NULL,               -- 'BTC' | 'ETH'
  tx_hash TEXT NOT NULL,
  value_usd NUMERIC(20,2) NOT NULL,
  from_address TEXT,
  to_address TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (chain, tx_hash)
);
CREATE INDEX IF NOT EXISTS whale_txns_time_idx ON crypto.whale_txns (observed_at DESC);
```

**Step 2: Şemayı uygula**

Run: `docker exec -i coinhit-pipeline-db psql -U coinhit -d coinhit < ~/coinhit-engine/db/crypto_schema.sql`
Expected: `CREATE SCHEMA`, `CREATE TABLE` x2, `CREATE INDEX` x2 çıktısı, hata yok.

**Step 3: Doğrula**

Run: `docker exec -i coinhit-pipeline-db psql -U coinhit -d coinhit -c '\dt crypto.*'`
Expected: `crypto.markets` ve `crypto.whale_txns` listelenir.

**Step 4: Commit**

```bash
cd ~/coinhit-engine && git add db/crypto_schema.sql && git commit -m "feat(crypto): add markets and whale_txns schema"
```

---

### Task 1.2: Worker iskeleti + Binance piyasa toplayıcı

**Files:**
- Create: `~/coinhit-engine/services/crypto_ingest/__init__.py` (boş)
- Create: `~/coinhit-engine/services/crypto_ingest/collectors.py`
- Test: `~/coinhit-engine/services/crypto_ingest/test_collectors.py`

**Step 1: Saf fonksiyonlar için başarısız testi yaz**

`collectors.py` henüz yokken, dönüşüm/filtreleme mantığını test eden dosyayı yaz (canlı ağ çağrısı olmayan kısım — Binance ticker JSON'unu bizim satır formatımıza çeviren fonksiyon):

```python
# ~/coinhit-engine/services/crypto_ingest/test_collectors.py
from collectors import parse_binance_ticker, TOP_SYMBOLS

def test_parse_binance_ticker_filters_top_symbols_and_maps_fields():
    raw = [
        {"symbol": "BTCUSDT", "lastPrice": "65000.50", "quoteVolume": "1200000000", "priceChangePercent": "2.5"},
        {"symbol": "UNKNOWNUSDT", "lastPrice": "1.0", "quoteVolume": "100", "priceChangePercent": "0"},
    ]
    result = parse_binance_ticker(raw)
    assert len(result) == 1
    assert result[0]["symbol"] == "BTC"
    assert result[0]["price_usd"] == 65000.50
    assert result[0]["volume_24h_usd"] == 1200000000.0
    assert result[0]["change_24h_pct"] == 2.5

def test_parse_binance_ticker_skips_malformed_rows():
    raw = [{"symbol": "BTCUSDT", "lastPrice": "not-a-number", "quoteVolume": "0", "priceChangePercent": "0"}]
    assert parse_binance_ticker(raw) == []

def test_top_symbols_includes_majors():
    assert "BTCUSDT" in TOP_SYMBOLS
    assert "ETHUSDT" in TOP_SYMBOLS
```

**Step 2: Testi çalıştırıp başarısız olduğunu doğrula**

Run: `cd ~/coinhit-engine/services/crypto_ingest && /home/ubuntu/coinhit-engine/.venv/bin/python -m pytest test_collectors.py -v`
Expected: `ModuleNotFoundError: No module named 'collectors'` ile FAIL.

**Step 3: Minimal implementasyonu yaz**

```python
# ~/coinhit-engine/services/crypto_ingest/collectors.py
"""Kripto istihbarat katmanı — veri toplayıcılar (Faz 1: piyasa + balina)."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))  # common.py için
from common import db, RateLimitedClient  # noqa: E402

TOP_SYMBOLS = [
    'BTCUSDT', 'ETHUSDT', 'BNBUSDT', 'SOLUSDT', 'XRPUSDT',
    'ADAUSDT', 'DOGEUSDT', 'MATICUSDT', 'DOTUSDT', 'LTCUSDT',
    'TRXUSDT', 'AVAXUSDT', 'LINKUSDT', 'ATOMUSDT', 'ETCUSDT',
    'XLMUSDT', 'UNIUSDT', 'NEARUSDT', 'APTUSDT', 'FILUSDT',
    'ARBUSDT', 'OPUSDT', 'INJUSDT', 'SUIUSDT', 'PEPEUSDT',
    'SHIBUSDT', 'AAVEUSDT', 'MKRUSDT', 'LDOUSDT', 'RNDRUSDT',
]

_client = RateLimitedClient(rps={"binance": 5, "coingecko": 1, "alternative_me": 0.2})


def parse_binance_ticker(raw: list[dict]) -> list[dict]:
    """Binance /api/v3/ticker/24hr yanıtını crypto.markets satırlarına çevirir."""
    out = []
    top = set(TOP_SYMBOLS)
    for item in raw:
        if item.get("symbol") not in top:
            continue
        try:
            out.append({
                "symbol": item["symbol"].replace("USDT", ""),
                "price_usd": float(item["lastPrice"]),
                "volume_24h_usd": float(item["quoteVolume"]),
                "change_24h_pct": float(item["priceChangePercent"]),
            })
        except (KeyError, ValueError, TypeError):
            continue
    return out


def fetch_global_metrics() -> dict:
    """BTC dominance (CoinGecko) + Fear&Greed Index (alternative.me). Keyless."""
    dominance = None
    try:
        g = _client.get_json("coingecko", "https://api.coingecko.com/api/v3/global", cache_ttl=120)
        dominance = g["data"]["market_cap_percentage"]["btc"]
    except Exception:
        pass
    fear_greed = None
    try:
        f = _client.get_json("alternative_me", "https://api.alternative.me/fng/", cache_ttl=1800)
        fear_greed = int(f["data"][0]["value"])
    except Exception:
        pass
    return {"btc_dominance_pct": dominance, "fear_greed_index": fear_greed}


def collect_markets() -> int:
    """Binance ticker + global metrikleri çeker, crypto.markets'e yazar. Yazılan satır sayısını döner."""
    raw = _client.get_json("binance", "https://api.binance.com/api/v3/ticker/24hr", cache_ttl=20)
    rows = parse_binance_ticker(raw)
    if not rows:
        return 0
    globals_ = fetch_global_metrics()
    with db() as conn:
        for r in rows:
            conn.execute(
                """INSERT INTO crypto.markets
                   (symbol, price_usd, volume_24h_usd, change_24h_pct, btc_dominance_pct, fear_greed_index)
                   VALUES (%s,%s,%s,%s,%s,%s)""",
                (r["symbol"], r["price_usd"], r["volume_24h_usd"], r["change_24h_pct"],
                 globals_["btc_dominance_pct"], globals_["fear_greed_index"]),
            )
    return len(rows)
```

**Step 4: Testi tekrar çalıştır, geçtiğini doğrula**

Run: `cd ~/coinhit-engine/services/crypto_ingest && /home/ubuntu/coinhit-engine/.venv/bin/python -m pytest test_collectors.py -v`
Expected: 3 test PASS.

**Step 5: Canlı entegrasyonu elle doğrula (network gerekli)**

Run: `cd ~/coinhit-engine/services/crypto_ingest && /home/ubuntu/coinhit-engine/.venv/bin/python -c "from collectors import collect_markets; print(collect_markets())"`
Expected: `30` (veya Binance'in döndürdüğü eşleşen sembol sayısı) — hata yok.

Run: `docker exec -i coinhit-pipeline-db psql -U coinhit -d coinhit -c "SELECT symbol, price_usd, btc_dominance_pct FROM crypto.markets ORDER BY collected_at DESC LIMIT 3;"`
Expected: 3 satır, gerçek fiyatlarla.

**Step 6: Commit**

```bash
cd ~/coinhit-engine && git add services/crypto_ingest/ && git commit -m "feat(crypto): add market data collector with tests"
```

---

### Task 1.3: Balina takibi toplayıcı (BTC mempool + ETH son blok, keyless)

**Files:**
- Modify: `~/coinhit-engine/services/crypto_ingest/collectors.py`
- Modify: `~/coinhit-engine/services/crypto_ingest/test_collectors.py`

**Step 1: Saf filtreleme fonksiyonu için başarısız test yaz**

```python
# test_collectors.py'ye ekle
from collectors import filter_whale_txns

def test_filter_whale_txns_applies_usd_threshold():
    txns = [
        {"chain": "BTC", "tx_hash": "a", "value_usd": 50000.0, "from_address": None, "to_address": None},
        {"chain": "BTC", "tx_hash": "b", "value_usd": 999.0, "from_address": None, "to_address": None},
    ]
    result = filter_whale_txns(txns, threshold_usd=10000)
    assert len(result) == 1
    assert result[0]["tx_hash"] == "a"
```

**Step 2: Çalıştır, FAIL olduğunu doğrula**

Run: `.venv/bin/python -m pytest test_collectors.py -v -k whale`
Expected: `ImportError: cannot import name 'filter_whale_txns'` ile FAIL.

**Step 3: Implementasyon**

```python
# collectors.py'ye ekle

BTC_WHALE_THRESHOLD_USD = 500_000
ETH_WHALE_THRESHOLD_USD = 500_000


def filter_whale_txns(txns: list[dict], threshold_usd: float) -> list[dict]:
    return [t for t in txns if t["value_usd"] >= threshold_usd]


def _latest_btc_price() -> float:
    with db() as conn:
        row = conn.execute(
            "SELECT price_usd FROM crypto.markets WHERE symbol='BTC' ORDER BY collected_at DESC LIMIT 1"
        ).fetchone()
        return float(row[0]) if row else 0.0


def _latest_eth_price() -> float:
    with db() as conn:
        row = conn.execute(
            "SELECT price_usd FROM crypto.markets WHERE symbol='ETH' ORDER BY collected_at DESC LIMIT 1"
        ).fetchone()
        return float(row[0]) if row else 0.0


def collect_btc_whales() -> int:
    """blockchain.info unconfirmed-transactions (keyless) üzerinden buyuk BTC transferleri."""
    btc_price = _latest_btc_price()
    if not btc_price:
        return 0
    data = _client.get_json("blockchain_info", "https://blockchain.info/unconfirmed-transactions?format=json", cache_ttl=30)
    candidates = []
    for tx in data.get("txs", []):
        total_sat = sum(o.get("value", 0) for o in tx.get("out", []))
        value_usd = (total_sat / 1e8) * btc_price
        candidates.append({
            "chain": "BTC", "tx_hash": tx.get("hash"), "value_usd": value_usd,
            "from_address": None, "to_address": (tx.get("out") or [{}])[0].get("addr"),
        })
    whales = filter_whale_txns(candidates, BTC_WHALE_THRESHOLD_USD)
    _insert_whales(whales)
    return len(whales)


def collect_eth_whales() -> int:
    """Public ETH RPC (keyless) uzerinden son bloktaki buyuk transferler."""
    eth_price = _latest_eth_price()
    if not eth_price:
        return 0
    latest = _client.get_json(
        "eth_rpc", "https://ethereum-rpc.publicnode.com",
        cache_ttl=10,
        # NOT: RateLimitedClient GET kullanır; JSON-RPC POST gerektirdiğinden
        # burada doğrudan httpx.Client POST ile çağrılır (bkz. gerçek dosyada
        # _client._http.post kullanımı) — testte mock'lanır.
    )
    candidates = []
    for tx in latest.get("result", {}).get("transactions", []):
        try:
            value_wei = int(tx.get("value", "0x0"), 16)
        except ValueError:
            continue
        value_usd = (value_wei / 1e18) * eth_price
        candidates.append({
            "chain": "ETH", "tx_hash": tx.get("hash"), "value_usd": value_usd,
            "from_address": tx.get("from"), "to_address": tx.get("to"),
        })
    whales = filter_whale_txns(candidates, ETH_WHALE_THRESHOLD_USD)
    _insert_whales(whales)
    return len(whales)


def _insert_whales(whales: list[dict]) -> None:
    if not whales:
        return
    with db() as conn:
        for w in whales:
            conn.execute(
                """INSERT INTO crypto.whale_txns (chain, tx_hash, value_usd, from_address, to_address)
                   VALUES (%s,%s,%s,%s,%s) ON CONFLICT (chain, tx_hash) DO NOTHING""",
                (w["chain"], w["tx_hash"], w["value_usd"], w["from_address"], w["to_address"]),
            )
```

> Not: `collect_eth_whales` içindeki ETH JSON-RPC çağrısı `RateLimitedClient.get_json` bir GET yapar; JSON-RPC POST gerektirir. Implementasyon sırasında `_client._http.post(url, json={"jsonrpc":"2.0","method":"eth_getBlockByNumber","params":["latest",True],"id":1})` kullanılmalı — plan taslağı basitlik için `get_json` gösteriyor, gerçek kodda POST'a çevrilecek. Bu satırı yazarken testle doğrula.

**Step 4: Testi çalıştır, geçtiğini doğrula**

Run: `.venv/bin/python -m pytest test_collectors.py -v`
Expected: tüm testler (piyasa + whale filtre) PASS.

**Step 5: Canlı doğrulama**

Run: `.venv/bin/python -c "from collectors import collect_btc_whales, collect_eth_whales; print('BTC:', collect_btc_whales()); print('ETH:', collect_eth_whales())"`
Expected: hata yok, 0 veya daha fazla whale sayısı (eşik yüksek olduğundan çoğu döngüde 0 normal).

**Step 6: Commit**

```bash
cd ~/coinhit-engine && git add services/crypto_ingest/ && git commit -m "feat(crypto): add BTC/ETH whale transfer collectors"
```

---

### Task 1.4: Worker döngüsü + systemd servisi

**Files:**
- Create: `~/coinhit-engine/services/crypto_ingest/worker.py`
- Create (root, sudo ile kopyalanacak): `/tmp/crypto-ingest.service`

**Step 1: worker.py yaz**

```python
# ~/coinhit-engine/services/crypto_ingest/worker.py
"""Kripto istihbarat worker — surekli dongu, farkli araliklarla toplayicilari cagirir."""
import time
import traceback

from collectors import collect_markets, collect_btc_whales, collect_eth_whales

INTERVALS = {
    "markets": 30,
    "whales": 120,
}


def main():
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
            try:
                b = collect_btc_whales()
                e = collect_eth_whales()
                print(f"[whales] BTC={b} ETH={e}", flush=True)
            except Exception:
                traceback.print_exc()
            last_run["whales"] = now
        time.sleep(5)


if __name__ == "__main__":
    main()
```

**Step 2: Elle kısa süre çalıştır**

Run: `cd ~/coinhit-engine/services/crypto_ingest && timeout 40 /home/ubuntu/coinhit-engine/.venv/bin/python worker.py`
Expected: `crypto-ingest worker started` sonra `[markets] N satir yazildi` satırı 30sn içinde görünür, hata yok, 40sn sonra timeout ile çıkar (normal).

**Step 3: systemd unit dosyasını yaz**

```ini
# /tmp/crypto-ingest.service
[Unit]
Description=CoinHit Kripto Istihbarat Worker (piyasa+balina toplama)
After=network-online.target docker.service
Wants=network-online.target

[Service]
Type=simple
User=ubuntu
Group=ubuntu
WorkingDirectory=/home/ubuntu/coinhit-engine/services/crypto_ingest
ExecStart=/home/ubuntu/coinhit-engine/.venv/bin/python worker.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

**Step 4: Servisi kur ve başlat**

Run:
```bash
sudo cp /tmp/crypto-ingest.service /etc/systemd/system/crypto-ingest.service
sudo systemctl daemon-reload
sudo systemctl enable --now crypto-ingest.service
sleep 15
systemctl is-active crypto-ingest
```
Expected: `active`

**Step 5: Logları doğrula**

Run: `sudo journalctl -u crypto-ingest --since "1 min ago" --no-pager | tail -10`
Expected: `[markets] ... satir yazildi` satırları, hata yok.

**Step 6: Commit**

```bash
cd ~/coinhit-engine && git add services/crypto_ingest/worker.py && git commit -m "feat(crypto): add ingest worker loop and systemd service"
```

---

### Task 1.5: Osiris `pg` istemcisi + `/api/crypto/markets` rotası

**Files:**
- Modify: `~/osiris/package.json` (yeni bağımlılık)
- Create: `~/osiris/src/lib/cryptoDb.ts`
- Create: `~/osiris/src/app/api/crypto/markets/route.ts`
- Test: `~/osiris/src/app/api/crypto/markets/route.test.ts`
- Modify: `~/osiris/.env` ve `~/osiris/.env.example` (`CRYPTO_DATABASE_URL` ekle)

**Step 1: `pg` paketini kur**

Run: `cd ~/osiris && npm install pg && npm install -D @types/pg`
Expected: `package.json`'a `pg` ve `@types/pg` eklenir, hata yok.

**Step 2: `.env` / `.env.example`'a bağlantı stringi ekle**

`.env.example`'a ekle:
```
# Kripto istihbarat katmanı — coinhit postgres (crypto şeması, read-only kullanım)
CRYPTO_DATABASE_URL=postgresql://coinhit:PASSWORD@127.0.0.1:5433/coinhit
```
`.env` dosyasına gerçek şifreyle aynı satırı ekle (şifre `~/coinhit-engine/.env` içindeki `PIPELINE_DB_PASSWORD` ile aynı olmalı).

**Step 3: Saf dönüşüm fonksiyonu için başarısız test yaz**

```typescript
// ~/osiris/src/app/api/crypto/markets/route.test.ts
import { describe, it, expect } from 'vitest';
import { groupLatestBySymbol } from './route';

describe('groupLatestBySymbol', () => {
  it('keeps only the most recent row per symbol', () => {
    const rows = [
      { symbol: 'BTC', price_usd: 64000, collected_at: '2026-07-13T10:00:00Z' },
      { symbol: 'BTC', price_usd: 65000, collected_at: '2026-07-13T10:01:00Z' },
      { symbol: 'ETH', price_usd: 3000, collected_at: '2026-07-13T10:00:00Z' },
    ];
    const result = groupLatestBySymbol(rows as any);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.symbol === 'BTC')?.price_usd).toBe(65000);
  });

  it('returns empty array for empty input', () => {
    expect(groupLatestBySymbol([])).toEqual([]);
  });
});
```

**Step 4: Testi çalıştır, FAIL olduğunu doğrula**

Run: `cd ~/osiris && npx vitest run src/app/api/crypto/markets/route.test.ts`
Expected: modül bulunamadı hatasıyla FAIL (route.ts henüz yok).

**Step 5: `cryptoDb.ts` — paylaşımlı pg pool**

```typescript
// ~/osiris/src/lib/cryptoDb.ts
import { Pool } from 'pg';

let pool: Pool | null = null;

export function getCryptoDb(): Pool {
  if (!pool) {
    const connectionString = process.env.CRYPTO_DATABASE_URL;
    if (!connectionString) {
      throw new Error('CRYPTO_DATABASE_URL is not set');
    }
    pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 30000 });
  }
  return pool;
}
```

**Step 6: `route.ts` implementasyonu**

```typescript
// ~/osiris/src/app/api/crypto/markets/route.ts
import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface MarketRow {
  symbol: string;
  price_usd: number;
  volume_24h_usd: number | null;
  change_24h_pct: number | null;
  btc_dominance_pct: number | null;
  fear_greed_index: number | null;
  collected_at: string;
}

export function groupLatestBySymbol(rows: MarketRow[]): MarketRow[] {
  const latest = new Map<string, MarketRow>();
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
    const { rows } = await db.query<MarketRow>(
      `SELECT symbol, price_usd, volume_24h_usd, change_24h_pct,
              btc_dominance_pct, fear_greed_index, collected_at
       FROM crypto.markets
       WHERE collected_at > now() - interval '10 minutes'
       ORDER BY collected_at DESC`
    );
    const markets = groupLatestBySymbol(rows);
    return NextResponse.json(
      { markets, timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/markets fetch error:', error);
    return NextResponse.json({ markets: [], error: 'Failed' }, { status: 500 });
  }
}
```

**Step 7: Testi tekrar çalıştır**

Run: `cd ~/osiris && npx vitest run src/app/api/crypto/markets/route.test.ts`
Expected: 2 test PASS.

**Step 8: Dev sunucusuyla canlı doğrula**

Run: `cd ~/osiris && npm run build 2>&1 | tail -20`
Expected: build hatasız tamamlanır.

Run: `pm2 restart osiris && sleep 5 && curl -s http://localhost:3000/api/crypto/markets | head -c 400`
Expected: `{"markets":[{"symbol":"BTC",...`  gerçek verilerle JSON.

**Step 9: Commit**

```bash
cd ~/osiris && git add package.json package-lock.json src/lib/cryptoDb.ts src/app/api/crypto/markets/ .env.example && git commit -m "feat(crypto): add markets API route backed by crypto-ingest worker data"
```

---

### Task 1.6: `/api/crypto/whales` rotası

**Files:**
- Create: `~/osiris/src/app/api/crypto/whales/route.ts`
- Test: `~/osiris/src/app/api/crypto/whales/route.test.ts`

**Step 1: Başarısız test yaz**

```typescript
// ~/osiris/src/app/api/crypto/whales/route.test.ts
import { describe, it, expect } from 'vitest';
import { formatWhaleTxn } from './route';

describe('formatWhaleTxn', () => {
  it('rounds value_usd to nearest dollar for display', () => {
    const row = { chain: 'BTC', tx_hash: 'abc', value_usd: 512345.678, from_address: null, to_address: 'x', observed_at: '2026-07-13T10:00:00Z' };
    expect(formatWhaleTxn(row as any).value_usd).toBe(512346);
  });
});
```

**Step 2: FAIL olduğunu doğrula**

Run: `cd ~/osiris && npx vitest run src/app/api/crypto/whales/route.test.ts`
Expected: FAIL (route.ts yok).

**Step 3: Implementasyon**

```typescript
// ~/osiris/src/app/api/crypto/whales/route.ts
import { NextResponse } from 'next/server';
import { getCryptoDb } from '@/lib/cryptoDb';

export interface WhaleRow {
  chain: string;
  tx_hash: string;
  value_usd: number;
  from_address: string | null;
  to_address: string | null;
  observed_at: string;
}

export function formatWhaleTxn(row: WhaleRow): WhaleRow {
  return { ...row, value_usd: Math.round(row.value_usd) };
}

export async function GET() {
  try {
    const db = getCryptoDb();
    const { rows } = await db.query<WhaleRow>(
      `SELECT chain, tx_hash, value_usd, from_address, to_address, observed_at
       FROM crypto.whale_txns
       WHERE observed_at > now() - interval '24 hours'
       ORDER BY observed_at DESC
       LIMIT 50`
    );
    return NextResponse.json(
      { whales: rows.map(formatWhaleTxn), timestamp: new Date().toISOString() },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    console.error('crypto/whales fetch error:', error);
    return NextResponse.json({ whales: [], error: 'Failed' }, { status: 500 });
  }
}
```

**Step 4: Testi çalıştır**

Run: `cd ~/osiris && npx vitest run src/app/api/crypto/whales/route.test.ts`
Expected: PASS.

**Step 5: Build + canlı doğrula**

Run: `cd ~/osiris && npm run build && pm2 restart osiris && sleep 5 && curl -s http://localhost:3000/api/crypto/whales`
Expected: `{"whales":[...],"timestamp":"..."}` (whale eşiği yüksek olduğundan `whales: []` olması da normal).

**Step 6: Commit**

```bash
cd ~/osiris && git add src/app/api/crypto/whales/ && git commit -m "feat(crypto): add whale transactions API route"
```

---

### Task 1.7: Tüm Osiris test paketini doğrula

**Step 1:** Run: `cd ~/osiris && npm test 2>&1 | tail -30`
Expected: tüm testler (yeni ikisi dahil) PASS, hiçbir mevcut test kırılmamış.

**Step 2 (regresyon):** Run: `curl -s -o /dev/null -w "globe.coinhit.net → HTTP %{http_code}\n" https://globe.coinhit.net --max-time 15`
Expected: `HTTP 200` — mevcut canlı site bozulmamış.

**Faz 1 tamamlandı.** Artık `crypto.markets` ve `crypto.whale_txns` sürekli doluyor; Osiris bunları `/api/crypto/markets` ve `/api/crypto/whales` üzerinden sunuyor.

---

## FAZ 2 — Türev + Likidasyon (özet görev kırılımı)

> Faz 1 canlıya alındıktan sonra bu fazın görevleri, gerçek `crypto` şeması ve worker kalıbı üzerinden **yeni bir writing-plans geçişiyle** tam TDD detayına kavuşturulmalı. Aşağıdaki kırılım, o geçiş için başlangıç iskeletidir.

- **Şema:** `crypto.derivatives (symbol, funding_rate, open_interest_usd, long_short_ratio, collected_at)`, `crypto.liquidations (symbol, side, value_usd, price_usd, observed_at)`
- **Worker:** `collectors.py`'ye `collect_derivatives()` (Binance Futures `/fapi/v1/premiumIndex` + `/fapi/v1/openInterest`, keyless) ve `collect_liquidations()` (Binance Futures websocket `!forceOrder@arr` — worker'da ayrı bir uzun-ömürlü websocket task'ı gerektirir, `asyncio` geçişi gerekebilir)
- **Osiris rotaları:** `/api/crypto/derivatives`, `/api/crypto/liquidations`
- **Test kapsamı:** Faz 1 ile aynı kalıp — saf parse/eşik fonksiyonları unit test, route'lar için `groupLatestBySymbol` benzeri yardımcı fonksiyon testleri

---

## FAZ 3 — DeFi + Stablecoin + Coğrafi/Compliance (özet görev kırılımı)

- **Şema:** `crypto.defi_tvl (protocol, chain, tvl_usd, collected_at)`, `crypto.stablecoin_flows (symbol, chain, mint_usd, burn_usd, collected_at)`, `crypto.geo_nodes (kind, name, country, lat, lng, metric_value)`
- **Worker:** `collect_defi()` (DefiLlama `/protocols` ve `/stablecoins`, tamamen keyless), `collect_geo()` (madencilik hashrate dağılımı — statik/periyodik güncellenen veri seti, Osiris'in mevcut statik intel dosyaları kalıbına benzer şekilde `intel/` altına eklenebilir)
- **Compliance:** mevcut `src/lib/sanctions.ts` ve `/api/osint/sanctions` rotası **yeniden kullanılır** — whale adresleri toplanırken bu servise karşı otomatik kontrol eklenir (`crypto.compliance_hits` tablosuna eşleşenler yazılır)
- **UI:** Osiris küresine "Kripto Modu" — `src/components/CryptoPanel.tsx` (yeni), `MarketsPanel.tsx`'in yanına `page.tsx`'e kayıt (bkz. mevcut `MarketsPanel` kayıt deseni, satır ~976)

---

## FAZ 4 — Sinyal Bus + Pythia/İçerik Motoru Entegrasyonu (özet görev kırılımı)

- **Redis:** yeni `crypto-redis` container (`redis:7-alpine`, `coinhit-engine_default` ağında, host portu 6380), `docker-compose.yml`'e eklenir
- **Kural motoru:** worker içinde `signals.py` — eşik-tabanlı olay üretimi (whale > $1M, funding aşırı uç, likidasyon kaskadı, OFAC eşleşme, TVL ani düşüş, stablecoin depeg) → `crypto.signals` tablosuna yaz + redis `PUBLISH crypto.signals <json>`
- **Pythia entegrasyonu:** `pythia-project/integrations/osiris/` altına kripto feed tüketici eklenir (mevcut `OSIRIS_URL` bağlantısı üzerinden `/api/crypto/markets` + `/api/crypto/signals` çekilir)
- **İçerik motoru entegrasyonu:** `coinhit-engine/services/`'e küçük bir `crypto_signal_subscriber.py` — redis `SUBSCRIBE crypto.signals`, gelen olayları `pipeline.articles`'a `topic` olarak enjekte eder (curator/orchestrator mevcut state machine'i devralır)
- **İç sinyaller:** `/api/crypto/signals` rotası — kimlik doğrulama gerektirir (Osiris'in mevcut auth deseni araştırılmalı; yoksa basit bearer-token guard eklenir)

---

## Genel Doğrulama Kriterleri (her faz sonunda)

1. `cd ~/coinhit-engine/services/crypto_ingest && .venv/bin/python -m pytest -v` → tüm testler PASS
2. `cd ~/osiris && npm test` → tüm testler PASS
3. `systemctl is-active crypto-ingest` → `active`, `journalctl -u crypto-ingest` hatasız
4. `curl -s https://globe.coinhit.net` → HTTP 200 (regresyon yok)
5. Yeni her API rotası: `curl -s https://globe.coinhit.net/api/crypto/<rota>` gerçek veriyle yanıt verir
