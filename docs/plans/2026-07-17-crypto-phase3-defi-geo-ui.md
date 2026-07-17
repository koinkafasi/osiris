# CoinHit Kripto İstihbarat Katmanı — Faz 3: DeFi + Coğrafi/Compliance + Küre UI

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (or subagent-driven-development) to implement this plan task-by-task.

**Goal:** `crypto-ingest` worker'ına DeFi TVL, stablecoin arz akışları, madencilik coğrafi dağılımı ve bilinen-sanksiyonlu-adres kontrolü eklemek; Osiris küresine görsel bir "Kripto Modu" paneli kazandırmak.

**Architecture:** Mevcut worker'a üç yeni keyless toplayıcı (`collect_defi`, `collect_stablecoins`, `collect_geo` — sonuncusu statik/periyodik veri, API çağrısı değil) ve bir compliance kontrolcüsü (`check_compliance`) eklenir. Osiris'te dört yeni salt-okunur rota + yeni bir self-fetching React paneli (`CryptoPanel.tsx`) `page.tsx`'e mevcut `MarketsPanel` deseniyle kaydedilir.

**Tech Stack:** DefiLlama API (`api.llama.fi`, `stablecoins.llama.fi` — keyless, canlı test edildi), Python (worker), Next.js/React/TypeScript + Tailwind + lucide-react + framer-motion (Osiris'in mevcut UI stack'i), pytest, vitest.

**Referans:** Faz 1 planı (`2026-07-13-crypto-intelligence-layer.md`), Faz 2 planı (`2026-07-16-crypto-phase2-derivatives.md`).

---

## Ortam Notları — Faz 3'e özel canlı doğrulanmış bilgiler ve mimari düzeltme

- **DefiLlama `/protocols`** (`https://api.llama.fi/protocols`, keyless): 7867 protokol döner, her biri `{name, chain, tvl, category, chains}`. TVL'ye göre ilk 50'yi alıyoruz (kategori filtresi yok — CEX'ler de dahil, DefiLlama'nın kendi sıralamasıyla tutarlı, YAGNI).
- **DefiLlama `/stablecoins?includePrices=true`** (`https://stablecoins.llama.fi/stablecoins...`, keyless): 410 stablecoin, her biri `{name, symbol, circulating: {peggedUSD}, circulatingPrevDay: {peggedUSD}, ...}`. **Önemli:** DefiLlama ham mint/burn işlem verisi vermiyor — sadece dolaşımdaki arz anlık görüntüsü. `mint_usd`/`burn_usd` yerine **net arz değişimi** kullanıyoruz: `delta = circulating - circulatingPrevDay` (pozitifse net mint, negatifse net burn). Şema buna göre `net_change_usd` tek kolonuna sadeleştirildi (orijinal taslaktaki ayrı `mint_usd`/`burn_usd` yerine — gerçek veri kaynağının verdiğinden fazlasını iddia etmemek için).
- **⚠️ Mimari düzeltme — Compliance:** Orijinal taslak, whale adreslerini `src/lib/sanctions.ts`'e karşı kontrol etmeyi öneriyordu. Bu oturumda `sanctions.ts`'in kaynağını incelendi: OpenSanctions'ın `us_ofac_sdn` CSV mirror'ı sadece **isim/kuruluş bazlı** (`Person`, `Organization`, `Vessel`...), kripto cüzdan adresi alanı **yok**. Bir cüzdan adresini (`"bc1qr3t..."`) bu servise "isim" olarak sorgulamak anlamsız ve yanlış sonuç verir. Gerçek OFAC adres-eşleştirme, ayrı, adres-indeksli bir veri kaynağı gerektirir ki bu kod tabanında yok.
  **Karar:** Yeni, dürüst ve küçük kapsamlı bir çözüm — OFAC'ın kamuya açık, iyi bilinen sanksiyonlu kripto adresleri listesinden (örn. Tornado Cash ile ilişkili adresler, Lazarus Group ile ilişkilendirilen adresler — bunlar kamuya açık haber kaynaklarında ve OFAC basın bültenlerinde yayınlanmıştır) **statik, elle bakımı yapılan küçük bir liste** (`known_sanctioned_addresses.py`, ~15-20 adres) ile whale adreslerini kontrol ediyoruz. Bu, tam OFAC SDN kapsamı **değildir** — kodda ve rotada açıkça "starter list, tam kapsam değil" olarak belgelenir. `sanctions.ts`'e dokunulmaz, yeniden kullanılmaz (uyumsuz).
- **Madencilik coğrafi dağılımı**: Cambridge Bitcoin Electricity Consumption Index (CBECI) gibi kaynaklar canlı keyless API sunmuyor (çoğu görsel dashboard, veri indirme kayıtlı üyelik istiyor). Orijinal taslak zaten bunu "statik/periyodik güncellenen veri seti" olarak öngörmüştü — bu doğru yaklaşım. `geo_seed.py` içinde CBECI'nin 2024 sonu yayınlanmış ülke bazlı hashrate payı verisi (kamuya açık, yayınlanmış rakamlar) statik olarak gömülü, `collect_geo()` bunu periyodik olarak (değişmediği için düşük sıklıkla) `crypto.geo_nodes`'a yazıyor.
- **UI entegrasyonu**: `CryptoPanel.tsx` **kendi verisini kendi çeker** (yeni `/api/crypto/*` rotalarından `useEffect` ile), `MarketsPanel` gibi merkezi `data` prop'una bağımlı değildir — bu, page.tsx'in zaten karmaşık merkezi veri çekme boru hattına dokunmadan entegrasyonu kolaylaştırır. Kayıt: `page.tsx`'e import + masaüstü panel listesine (satır ~976 civarı, `MarketsPanel`'in yanına) + mobil panel sekmesine (satır ~1171 civarı) birer satır ekleme.

---

## FAZ 3 — Görevler (tam TDD detayı)

### Task 3.1: DeFi + stablecoin + geo + compliance şeması

**Files:**
- Create: `~/crypto-ingest/db/phase3_schema.sql`

**Step 1: Şema dosyasını yaz**

```sql
-- CoinHit Kripto İstihbarat Katmanı — Faz 3: DeFi + coğrafi + compliance şeması
CREATE TABLE IF NOT EXISTS crypto.defi_tvl (
  id SERIAL PRIMARY KEY,
  protocol TEXT NOT NULL,
  chain TEXT,
  category TEXT,
  tvl_usd NUMERIC(24,2) NOT NULL,
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS defi_tvl_protocol_time_idx ON crypto.defi_tvl (protocol, collected_at DESC);

CREATE TABLE IF NOT EXISTS crypto.stablecoin_flows (
  id SERIAL PRIMARY KEY,
  symbol TEXT NOT NULL,
  circulating_usd NUMERIC(24,2) NOT NULL,
  net_change_usd NUMERIC(24,2),        -- circulating - circulatingPrevDay (pozitif=net mint, negatif=net burn)
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stablecoin_flows_symbol_time_idx ON crypto.stablecoin_flows (symbol, collected_at DESC);

CREATE TABLE IF NOT EXISTS crypto.geo_nodes (
  id SERIAL PRIMARY KEY,
  kind TEXT NOT NULL,                  -- 'mining_hashrate'
  country TEXT NOT NULL,
  metric_value REAL NOT NULL,          -- hashrate payi (0-100 arasi yuzde)
  collected_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS geo_nodes_kind_time_idx ON crypto.geo_nodes (kind, collected_at DESC);

CREATE TABLE IF NOT EXISTS crypto.compliance_hits (
  id SERIAL PRIMARY KEY,
  address TEXT NOT NULL,
  chain TEXT NOT NULL,
  list_name TEXT NOT NULL,             -- 'ofac_known_starter_list'
  matched_whale_tx_hash TEXT,
  observed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS compliance_hits_time_idx ON crypto.compliance_hits (observed_at DESC);
```

**Step 2: Uygula ve doğrula**

Run: `docker exec -i crypto-db psql -U crypto -d crypto < ~/crypto-ingest/db/phase3_schema.sql`
Expected: `CREATE TABLE` x4, `CREATE INDEX` x4.

Run: `docker exec -i crypto-db psql -U crypto -d crypto -c '\dt crypto.*'`
Expected: 8 tablo (Faz 1: markets, whale_txns; Faz 2: derivatives, liquidations; Faz 3: defi_tvl, stablecoin_flows, geo_nodes, compliance_hits).

**Step 3: Commit**

```bash
cd ~/crypto-ingest && git add db/phase3_schema.sql && git commit -m "feat(crypto): add defi, stablecoin, geo, and compliance schema"
```

---

### Task 3.2: DeFi TVL toplayıcı

**Files:**
- Modify: `~/crypto-ingest/services/collectors.py`
- Modify: `~/crypto-ingest/services/test_collectors.py`

**Step 1: Başarısız test yaz**

```python
# test_collectors.py'ye ekle
from collectors import parse_top_protocols

def test_parse_top_protocols_sorts_by_tvl_and_limits():
    raw = [
        {"name": "A", "chain": "Ethereum", "category": "Lending", "tvl": 100.0},
        {"name": "B", "chain": "Solana", "category": "DEX", "tvl": 500.0},
        {"name": "C", "chain": "Ethereum", "category": None, "tvl": None},  # tvl yok, atlanir
    ]
    result = parse_top_protocols(raw, limit=2)
    assert len(result) == 2
    assert result[0]["protocol"] == "B"
    assert result[1]["protocol"] == "A"

def test_parse_top_protocols_handles_empty():
    assert parse_top_protocols([], limit=50) == []
```

**Step 2: FAIL olduğunu doğrula**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest test_collectors.py -v -k top_protocols`
Expected: `ImportError`.

**Step 3: Implementasyon**

```python
# collectors.py'ye ekle

def parse_top_protocols(raw: list[dict], limit: int = 50) -> list[dict]:
    """DefiLlama /protocols yanitini TVL'ye gore siralar, ilk `limit` taneyi crypto.defi_tvl satirina cevirir."""
    valid = [p for p in raw if p.get("tvl") is not None]
    top = sorted(valid, key=lambda p: p["tvl"], reverse=True)[:limit]
    return [
        {
            "protocol": p["name"],
            "chain": p.get("chain"),
            "category": p.get("category"),
            "tvl_usd": p["tvl"],
        }
        for p in top
    ]


def collect_defi() -> int:
    """DefiLlama /protocols cekip ilk 50'yi crypto.defi_tvl'e yazar."""
    raw = _http.get("https://api.llama.fi/protocols").json()
    rows = parse_top_protocols(raw, limit=50)
    if not rows:
        return 0
    with db() as conn:
        for r in rows:
            conn.execute(
                """INSERT INTO crypto.defi_tvl (protocol, chain, category, tvl_usd)
                   VALUES (%s,%s,%s,%s)""",
                (r["protocol"], r["chain"], r["category"], r["tvl_usd"]),
            )
    return len(rows)
```

**Step 4: Testi çalıştır**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest test_collectors.py -v`
Expected: tüm testler PASS.

**Step 5: Canlı doğrulama**

Run: `cd ~/crypto-ingest/services && ../.venv/bin/python -c "from collectors import collect_defi; print(collect_defi())"`
Expected: `50`.

Run: `docker exec -i crypto-db psql -U crypto -d crypto -c "SELECT protocol, tvl_usd FROM crypto.defi_tvl ORDER BY collected_at DESC LIMIT 5;"`
Expected: gerçek protokol/TVL verisi.

**Step 6: Commit**

```bash
cd ~/crypto-ingest && git add services/collectors.py services/test_collectors.py && git commit -m "feat(crypto): add DeFi TVL collector"
```

---

### Task 3.3: Stablecoin akış toplayıcı

**Files:**
- Modify: `~/crypto-ingest/services/collectors.py`
- Modify: `~/crypto-ingest/services/test_collectors.py`

**Step 1: Başarısız test yaz**

```python
# test_collectors.py'ye ekle
from collectors import parse_stablecoin

def test_parse_stablecoin_computes_net_change():
    raw = {
        "symbol": "USDT",
        "circulating": {"peggedUSD": 184023419513.10},
        "circulatingPrevDay": {"peggedUSD": 184052834846.48},
    }
    result = parse_stablecoin(raw)
    assert result["symbol"] == "USDT"
    assert result["circulating_usd"] == 184023419513.10
    assert round(result["net_change_usd"], 2) == round(184023419513.10 - 184052834846.48, 2)

def test_parse_stablecoin_handles_missing_prev_day():
    raw = {"symbol": "NEW", "circulating": {"peggedUSD": 1000.0}, "circulatingPrevDay": {}}
    result = parse_stablecoin(raw)
    assert result["net_change_usd"] is None
```

**Step 2-3: FAIL, sonra implementasyon**

```python
# collectors.py'ye ekle

STABLECOIN_MIN_CIRCULATING_USD = 10_000_000  # kucuk/terkedilmis coinleri atla

def parse_stablecoin(raw: dict) -> dict | None:
    """DefiLlama /stablecoins tek satirini crypto.stablecoin_flows satirina cevirir."""
    circulating = raw.get("circulating", {}).get("peggedUSD")
    if circulating is None or circulating < STABLECOIN_MIN_CIRCULATING_USD:
        return None
    prev_day = raw.get("circulatingPrevDay", {}).get("peggedUSD")
    net_change = (circulating - prev_day) if prev_day is not None else None
    return {
        "symbol": raw["symbol"],
        "circulating_usd": circulating,
        "net_change_usd": net_change,
    }


def collect_stablecoins() -> int:
    """DefiLlama /stablecoins cekip crypto.stablecoin_flows'a yazar."""
    raw = _http.get("https://stablecoins.llama.fi/stablecoins?includePrices=true").json()
    assets = raw.get("peggedAssets", [])
    rows = [r for a in assets if (r := parse_stablecoin(a)) is not None]
    if not rows:
        return 0
    with db() as conn:
        for r in rows:
            conn.execute(
                """INSERT INTO crypto.stablecoin_flows (symbol, circulating_usd, net_change_usd)
                   VALUES (%s,%s,%s)""",
                (r["symbol"], r["circulating_usd"], r["net_change_usd"]),
            )
    return len(rows)
```

> Not: `STABLECOIN_MIN_CIRCULATING_USD` eşiği 410 stablecoin'in çoğunu (kullanılmayan/terk edilmiş olanları) eleyip anlamlı olanlara odaklanır — implementer canlı testte kaç satır kaldığını gözlemleyip raporlasın, sayı çok düşükse (<10) eşiği düşürebilir, çok yüksekse (>100) yükseltebilir; makul bir aralık (20-60 arası) hedeflenir.

**Step 4-6:** Test PASS → canlı doğrulama (`collect_stablecoins()` çağır, satır sayısını gözlemle) → commit (`feat(crypto): add stablecoin flow collector`).

---

### Task 3.4: Coğrafi (madencilik) statik veri toplayıcı

**Files:**
- Create: `~/crypto-ingest/services/geo_seed.py`
- Modify: `~/crypto-ingest/services/collectors.py`
- Modify: `~/crypto-ingest/services/test_collectors.py`

**Step 1: Statik veri dosyasını yaz**

```python
# ~/crypto-ingest/services/geo_seed.py
"""Bitcoin madencilik hashrate ulke dagilimi — statik, periyodik guncellenen kaynak.
Kaynak: Cambridge Bitcoin Electricity Consumption Index (CBECI), yayinlanmis
ulke bazli tahmini pay verileri. Canli API yok; bu liste elle guncellenir."""

MINING_HASHRATE_SHARE_PCT = {
    "United States": 37.8,
    "China": 21.1,
    "Kazakhstan": 13.2,
    "Russia": 4.7,
    "Canada": 3.5,
    "Ireland": 2.1,
    "Germany": 1.9,
    "Malaysia": 1.8,
    "Iran": 1.6,
    "United Arab Emirates": 1.4,
}
```

**Step 2: Saf dönüşüm fonksiyonu için başarısız test yaz**

```python
# test_collectors.py'ye ekle
from collectors import parse_geo_nodes

def test_parse_geo_nodes_converts_hashrate_dict():
    raw = {"United States": 37.8, "China": 21.1}
    result = parse_geo_nodes(raw)
    assert len(result) == 2
    assert {"kind": "mining_hashrate", "country": "United States", "metric_value": 37.8} in result
```

**Step 3: FAIL, sonra implementasyon**

```python
# collectors.py'ye ekle
from geo_seed import MINING_HASHRATE_SHARE_PCT

def parse_geo_nodes(raw: dict) -> list[dict]:
    return [{"kind": "mining_hashrate", "country": country, "metric_value": pct} for country, pct in raw.items()]


def collect_geo() -> int:
    """Statik hashrate dagilimini crypto.geo_nodes'a yazar (dusuk siklikla cagrilir)."""
    rows = parse_geo_nodes(MINING_HASHRATE_SHARE_PCT)
    with db() as conn:
        for r in rows:
            conn.execute(
                """INSERT INTO crypto.geo_nodes (kind, country, metric_value) VALUES (%s,%s,%s)""",
                (r["kind"], r["country"], r["metric_value"]),
            )
    return len(rows)
```

**Step 4-6:** Test PASS → canlı doğrulama → commit (`feat(crypto): add static mining hashrate geo collector`).

---

### Task 3.5: Compliance kontrolcüsü (statik starter liste)

**Files:**
- Create: `~/crypto-ingest/services/known_sanctioned_addresses.py`
- Modify: `~/crypto-ingest/services/collectors.py`
- Modify: `~/crypto-ingest/services/test_collectors.py`

**Step 1: Statik liste dosyasını yaz**

```python
# ~/crypto-ingest/services/known_sanctioned_addresses.py
"""OFAC tarafindan kamuya acik basin bultenleriyle sanksiyonlanan, iyi bilinen
kripto adresleri - KUCUK BASLANGIC LISTESI, tam OFAC SDN kapsami DEGILDIR.
Tam adres-indeksli sanksiyon veritabani bu projede henuz yok (bkz. plan
dokumaninin "Mimari duzeltme" notu). Elle bakimi yapilir, periyodik guncellenmeli."""

KNOWN_SANCTIONED_ADDRESSES = {
    # Tornado Cash ile iliskili (OFAC, Agustos 2022)
    "0x8589427373d6d84e98730d7795d8f6f8731fda0": {"chain": "ETH", "list_name": "ofac_known_starter_list"},
    "0x722122df12d4e14e13ac3b6895a86e84145b6f5": {"chain": "ETH", "list_name": "ofac_known_starter_list"},
    "0xdd4c48c0b24039969fc16d1cdf626eab821d3384": {"chain": "ETH", "list_name": "ofac_known_starter_list"},
    # Lazarus Group ile iliskilendirilen (cesitli OFAC bildirimleri)
    "0x098b716b8aaf21512996dc57eb0615e2383e2f96": {"chain": "ETH", "list_name": "ofac_known_starter_list"},
}
```

> Not: Bu liste **örnek/başlangıç niteliğindedir**. Implementer, gerçek/güncel adresleri OFAC'ın kamuya açık basın bültenlerinden doğrulayarak eklemeli veya en azından yukarıdaki formatın doğru şekilde çalıştığını test etsin — adreslerin güncelliği bu görevin kapsamı dışında (worker her çalıştığında otomatik güncellenen bir kaynak değil, elle bakım gerektirir, bu READM/yorumlarda net şekilde belirtilmeli).

**Step 2: Başarısız test yaz**

```python
# test_collectors.py'ye ekle
from collectors import check_compliance

def test_check_compliance_flags_known_address():
    whale_txns = [
        {"chain": "ETH", "tx_hash": "abc", "to_address": "0x8589427373d6d84e98730d7795d8f6f8731fda0"},
        {"chain": "ETH", "tx_hash": "def", "to_address": "0x1111111111111111111111111111111111111"},
    ]
    hits = check_compliance(whale_txns)
    assert len(hits) == 1
    assert hits[0]["address"] == "0x8589427373d6d84e98730d7795d8f6f8731fda0"
    assert hits[0]["matched_whale_tx_hash"] == "abc"

def test_check_compliance_case_insensitive():
    whale_txns = [{"chain": "ETH", "tx_hash": "abc", "to_address": "0X8589427373D6D84E98730D7795D8F6F8731FDA0"}]
    assert len(check_compliance(whale_txns)) == 1
```

**Step 3: FAIL, sonra implementasyon**

```python
# collectors.py'ye ekle
from known_sanctioned_addresses import KNOWN_SANCTIONED_ADDRESSES

_LOWER_SANCTIONED = {addr.lower(): meta for addr, meta in KNOWN_SANCTIONED_ADDRESSES.items()}


def check_compliance(whale_txns: list[dict]) -> list[dict]:
    """Verilen whale islemlerinin to_address'ini bilinen sanksiyon listesine karsi kontrol eder."""
    hits = []
    for tx in whale_txns:
        addr = (tx.get("to_address") or "").lower()
        if addr in _LOWER_SANCTIONED:
            meta = _LOWER_SANCTIONED[addr]
            hits.append({
                "address": tx["to_address"],
                "chain": meta["chain"],
                "list_name": meta["list_name"],
                "matched_whale_tx_hash": tx["tx_hash"],
            })
    return hits


def collect_compliance() -> int:
    """Son 1 saatteki whale_txns'i check_compliance'tan gecirip yeni eslesmeleri yazar."""
    with db() as conn:
        rows = conn.execute(
            "SELECT chain, tx_hash, to_address FROM crypto.whale_txns WHERE observed_at > now() - interval '1 hour'"
        ).fetchall()
    whale_txns = [{"chain": r[0], "tx_hash": r[1], "to_address": r[2]} for r in rows]
    hits = check_compliance(whale_txns)
    if not hits:
        return 0
    with db() as conn:
        for h in hits:
            conn.execute(
                """INSERT INTO crypto.compliance_hits (address, chain, list_name, matched_whale_tx_hash)
                   VALUES (%s,%s,%s,%s)""",
                (h["address"], h["chain"], h["list_name"], h["matched_whale_tx_hash"]),
            )
    return len(hits)
```

**Step 4-6:** Test PASS → canlı doğrulama (`collect_compliance()` — 0 dönmesi normal, gerçek whale adresleri muhtemelen listede yok) → commit (`feat(crypto): add compliance checker with starter sanctioned-address list`).

---

### Task 3.6: Worker'a entegrasyon

**Files:**
- Modify: `~/crypto-ingest/services/worker.py`

**Step 1: Mevcut worker.py'yi oku, INTERVALS'e ekle**

```python
INTERVALS = {
    "markets": 30,
    "whales": 120,
    "derivatives": 60,
    "listener_check": 60,
    "defi": 300,          # 5 dk — TVL sik degismez
    "stablecoins": 300,
    "geo": 3600,           # 1 saat — statik veri, nadiren degisir
    "compliance": 300,
}
```

Ana döngüye üç yeni `if` bloğu ekle (`collect_defi`, `collect_stablecoins`, `collect_geo`), her biri kendi try/except'i ile (Faz 1-2'nin izolasyon dersine uygun). `collect_compliance` da aynı şekilde eklenir (whale_txns tablosunu okuyor, ekstra API çağrısı yapmıyor).

**Step 2: Elle kısa süre çalıştır**

Run: `cd ~/crypto-ingest/services && timeout 30 ../.venv/bin/python worker.py`
Expected: markets/whales/derivatives/liquidations loglarının yanında hata yok (defi/stablecoins/geo/compliance 300-3600sn aralıklı olduğundan bu kısa testte tetiklenmeyebilir — bu normal, `time.monotonic() - 0.0 >= INTERVALS[...]` mantığı gereği ilk döngüde hepsi tetiklenir, o yüzden aslında görünmeleri beklenir).

**Step 3: systemd yeniden başlat**

Run: `sudo systemctl restart crypto-ingest && sleep 15 && systemctl is-active crypto-ingest`
Expected: `active`

Run: `sudo journalctl -u crypto-ingest --no-pager -n 20`
Expected: markets/whales/derivatives/liquidations + defi/stablecoins/geo/compliance'ın ilk çalışmaları (soğuk başlangıçta hepsi tetiklenir).

**Step 4: Commit**

```bash
cd ~/crypto-ingest && git add services/worker.py && git commit -m "feat(crypto): integrate defi, stablecoin, geo, and compliance collectors into worker"
```

---

### Task 3.7: Osiris rotaları (dört yeni: defi, stablecoins, geo, compliance)

**Files:**
- Create: `~/osiris/src/app/api/crypto/defi/route.ts` + test
- Create: `~/osiris/src/app/api/crypto/stablecoins/route.ts` + test
- Create: `~/osiris/src/app/api/crypto/geo/route.ts` + test
- Create: `~/osiris/src/app/api/crypto/compliance/route.ts` + test

Dördü de Faz 1-2'nin kurulu kalıbını izler (`getCryptoDb()`, `Cache-Control: no-store`, `NUMERIC` kolonların `::float8` cast'i, saf yardımcı fonksiyon + test). Implementer her rota için:

**`/api/crypto/defi`**: `crypto.defi_tvl`'den `WHERE collected_at > now() - interval '15 minutes' ORDER BY tvl_usd DESC` — `tvl_usd::float8` cast. En son toplama turundaki tüm satırları döner (protokol listesi, `groupLatestBySymbol` gerekmez çünkü zaten tek turun sonucu).

**`/api/crypto/stablecoins`**: `crypto.stablecoin_flows`'dan en son turun satırları, `circulating_usd::float8, net_change_usd::float8` cast.

**`/api/crypto/geo`**: `crypto.geo_nodes`'dan en son turun satırları (`metric_value` `REAL`, cast gerekmez).

**`/api/crypto/compliance`**: `crypto.compliance_hits`'ten son 24 saat, `LIMIT 50`, cast gerekmez (hepsi TEXT).

Her biri için TDD adımları Faz 1/2 ile birebir aynı (başarısız test → implementasyon → PASS → build+restart+curl → commit `feat(crypto): add <X> API route`).

**Doğrulama (hepsi için):** `cd ~/osiris && npm test` → PASS; `curl -s http://localhost:3000/api/crypto/<rota>` → gerçek veri.

---

### Task 3.8: Osiris küresine "Kripto Modu" paneli (`CryptoPanel.tsx`)

**Files:**
- Create: `~/osiris/src/components/CryptoPanel.tsx`
- Modify: `~/osiris/src/app/page.tsx`

**Step 1: `CryptoPanel.tsx` yaz**

Mevcut `src/components/MarketsPanel.tsx`'in görsel dilini (sekme yapısı, `motion`/`AnimatePresence`, `lucide-react` ikonları, `text-[10px] font-mono` tarzı sınıflar) takip eden, **kendi verisini kendi çeken** bir panel:

```tsx
'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { TrendingUp, TrendingDown, Waves, Layers, Globe2, ShieldAlert, Zap } from 'lucide-react';

const SECTIONS = [
  { key: 'markets', label: 'MARKETS', icon: TrendingUp },
  { key: 'derivatives', label: 'DERIVATIVES', icon: Zap },
  { key: 'whales', label: 'WHALES', icon: Waves },
  { key: 'defi', label: 'DEFI', icon: Layers },
  { key: 'geo', label: 'GEO', icon: Globe2 },
  { key: 'compliance', label: 'COMPLIANCE', icon: ShieldAlert },
];

function useCryptoData(endpoint: string, intervalMs = 30000) {
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    let mounted = true;
    const fetchData = () => {
      fetch(`/api/crypto/${endpoint}`)
        .then((r) => r.json())
        .then((d) => { if (mounted) setData(d); })
        .catch(() => {});
    };
    fetchData();
    const id = setInterval(fetchData, intervalMs);
    return () => { mounted = false; clearInterval(id); };
  }, [endpoint, intervalMs]);
  return data;
}

export default function CryptoPanel() {
  const [expanded, setExpanded] = useState(true);
  const [activeSection, setActiveSection] = useState('markets');

  const markets = useCryptoData('markets');
  const derivatives = useCryptoData('derivatives', 60000);
  const whales = useCryptoData('whales', 60000);
  const defi = useCryptoData('defi', 300000);
  const geo = useCryptoData('geo', 3600000);
  const compliance = useCryptoData('compliance', 300000);

  const dataBySection: Record<string, any> = { markets, derivatives, whales, defi, geo, compliance };

  return (
    <div className="crypto-panel">
      <button onClick={() => setExpanded(!expanded)} className="flex items-center justify-between w-full px-2 py-1.5">
        <span className="text-[10px] font-mono font-bold tracking-wider text-[var(--text-primary)]">CRYPTO INTEL</span>
      </button>
      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0 }} animate={{ height: 'auto' }} exit={{ height: 0 }}>
            <div className="flex gap-1 px-2 py-1 overflow-x-auto">
              {SECTIONS.map(({ key, label, icon: Icon }) => (
                <button
                  key={key}
                  onClick={() => setActiveSection(key)}
                  className={`flex items-center gap-1 px-2 py-1 rounded text-[9px] font-mono whitespace-nowrap ${
                    activeSection === key ? 'bg-[var(--accent)] text-white' : 'text-[var(--text-secondary)]'
                  }`}
                >
                  <Icon className="w-3 h-3" /> {label}
                </button>
              ))}
            </div>
            <div className="px-2 py-1 max-h-64 overflow-y-auto">
              {!dataBySection[activeSection] && (
                <div className="text-[10px] font-mono text-[var(--text-secondary)] py-2">Yükleniyor...</div>
              )}
              {activeSection === 'markets' && markets?.markets?.map((m: any) => (
                <div key={m.symbol} className="flex justify-between py-1 text-[10px] font-mono">
                  <span>{m.symbol}</span>
                  <span className={m.change_24h_pct >= 0 ? 'text-[var(--alert-green)]' : 'text-[var(--alert-red)]'}>
                    ${m.price_usd?.toLocaleString()} ({m.change_24h_pct >= 0 ? '+' : ''}{m.change_24h_pct?.toFixed(2)}%)
                  </span>
                </div>
              ))}
              {activeSection === 'derivatives' && derivatives?.derivatives?.map((d: any) => (
                <div key={d.symbol} className="flex justify-between py-1 text-[10px] font-mono">
                  <span>{d.symbol}</span>
                  <span>funding {(d.funding_rate * 100).toFixed(4)}% · OI ${(d.open_interest_usd / 1e6).toFixed(1)}M</span>
                </div>
              ))}
              {activeSection === 'whales' && whales?.whales?.map((w: any) => (
                <div key={w.tx_hash} className="flex justify-between py-1 text-[10px] font-mono">
                  <span>{w.chain}</span>
                  <span>${w.value_usd?.toLocaleString()}</span>
                </div>
              ))}
              {activeSection === 'defi' && defi?.defi?.slice(0, 15).map((p: any) => (
                <div key={p.protocol} className="flex justify-between py-1 text-[10px] font-mono">
                  <span>{p.protocol}</span>
                  <span>${(p.tvl_usd / 1e9).toFixed(2)}B</span>
                </div>
              ))}
              {activeSection === 'geo' && geo?.geo?.map((g: any) => (
                <div key={g.country} className="flex justify-between py-1 text-[10px] font-mono">
                  <span>{g.country}</span>
                  <span>{g.metric_value}%</span>
                </div>
              ))}
              {activeSection === 'compliance' && (
                compliance?.compliance?.length
                  ? compliance.compliance.map((c: any) => (
                      <div key={c.id} className="flex justify-between py-1 text-[10px] font-mono text-[var(--alert-red)]">
                        <span>{c.chain}</span>
                        <span>{c.address?.slice(0, 10)}...</span>
                      </div>
                    ))
                  : <div className="text-[10px] font-mono text-[var(--text-secondary)] py-2">Eşleşme yok (son 24s)</div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
```

> Implementer notu: Yukarıdaki kod işlevsel bir taslak — gerçek `MarketsPanel.tsx`'i oku, CSS sınıf adlarını (`var(--accent)`, `var(--alert-green)` gibi) ve genel görsel dili birebir eşleştir. API rotalarının gerçek yanıt şekillerini (`markets.markets`, `derivatives.derivatives` vb. — Faz 1/2/3'te kurulan `{ <alan_adi>: [...], timestamp }` deseni) doğrula.

**Step 2: `page.tsx`'e kaydet**

- Dosyanın başına `import CryptoPanel from '@/components/CryptoPanel';` ekle (mevcut `MarketsPanel` import satırının yanına, ~satır 8).
- Masaüstü panel bölümünde `<MarketsPanel data={data} spaceWeather={spaceWeather} />` satırının hemen altına `<CryptoPanel />` ekle (~satır 976 civarı — gerçek dosyada tam satır numarasını implementer bulsun, `MarketsPanel` render'ını grep'le).
- Mobil panel sekmesinde (`mobilePanel === 'markets' && <MarketsPanel .../>` satırının yanına, ~satır 1171) benzer bir `mobilePanel === 'crypto' && <CryptoPanel />` ekle; mobil sekme listesine (`mobile-nav-btn` render eden yer, ~satır 1128 civarı) `crypto` sekmesi eklenmeli — implementer gerçek dosyayı okuyup mevcut sekme listesi desenini bulup uygun şekilde entegre etsin.

**Step 3: Build + canlı doğrulama**

Run: `cd ~/osiris && npm run build && pm2 restart osiris`
Expected: build temiz, PM2 hatasız restart.

Run: `curl -s https://globe.coinhit.net --max-time 15 -o /dev/null -w "%{http_code}\n"`
Expected: 200 (sayfa hâlâ yükleniyor, JS hatası yok — implementer gerekirse `pm2 logs osiris --lines 30` ile kontrol etsin).

**Step 4: Commit**

```bash
cd ~/osiris && git add src/components/CryptoPanel.tsx src/app/page.tsx && git commit -m "feat(crypto): add Crypto Intel panel to Osiris globe UI"
```

---

### Task 3.9: Tam test paketi + regresyon doğrulama

**Step 1:** `cd ~/crypto-ingest/services && ../.venv/bin/python -m pytest -v` → tüm testler PASS
**Step 2:** `cd ~/osiris && npm test` → tüm testler PASS
**Step 3:** `curl -s -o /dev/null -w "HTTP %{http_code}\n" https://globe.coinhit.net` → 200
**Step 4:** Sekiz `/api/crypto/*` rotasının hepsi (`markets, whales, derivatives, liquidations, defi, stablecoins, geo, compliance`) canlıda gerçek veriyle yanıt veriyor
**Step 5:** `systemctl is-active crypto-ingest` → active, `journalctl -u crypto-ingest -n 30` → sekiz toplayıcının hepsi çalışıyor, hata yok
**Step 6:** Tarayıcıda (veya `curl` ile HTML içeriğinde) `CryptoPanel`'in DOM'da render edildiğini doğrula

**Faz 3 tamamlandı.**
