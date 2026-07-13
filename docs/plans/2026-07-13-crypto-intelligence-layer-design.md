# CoinHit Kripto İstihbarat Katmanı — Tasarım

**Tarih:** 2026-07-13
**Durum:** Onaylandı

## Amaç

Osiris'in kripto modülünü, kriptoyu ana odak haline getirecek şekilde ciddi ölçüde genişletmek — ancak mevcut OSINT alanlarını (havacılık, denizcilik, deprem, çatışma vb.) kaldırmadan. Sonuç, dört tüketiciyi besleyen merkezi bir kripto istihbarat katmanı olacak:

1. Halka açık kripto istihbarat panosu (globe.coinhit.net)
2. Pythia'nın MiroFish tahmin motoruna kripto verisi
3. coinhit-engine içerik motoruna otomatik sinyal/haber üretimi için olaylar
4. İç araştırma/trading sinyalleri (yalnızca yetkili erişim)

## Mevcut Durum (Keşif Bulguları)

- **Osiris** (`~/osiris`): Next.js 16 OSINT küresi, 34 API rotası, globe.coinhit.net üzerinde canlı. Kripto zaten var ama sınırlı: `/api/crypto` (CoinGecko fiyat), `/api/markets` (Yahoo Finance, kripto dahil), `src/lib/sanctions.ts` (OFAC eşleştirme).
- **Pythia** (`~/pythia-project`, github.com/jangles-byte/Pythia): MiroFish + Osiris'i birleştiren tahmin motoru, pythia.coinhit.net (port 8088) üzerinde çalışıyor. `integrations/osiris/` klasöründe zaten Osiris'e bağlı (OSIRIS_URL → localhost:3000).
- **coinhit-engine** (`~/coinhit-engine`): İçerik üretim pipeline'ı (curator/enricher/producer/orchestrator + editorial-brain). Kendi postgres'i var: `coinhit-pipeline-db` (pgvector/pg16, 127.0.0.1:5433, db=coinhit).
- **binance-market-aggregator.py** (`~/`): Top-30 kripto için Binance fiyat/hacim çeken script, Ghost CMS için yazılmış — worker'ın çekirdeği olarak yeniden kullanılacak.
- Ayrı bir redis yok ama `social_redis_1` (redis:7-alpine) çalışıyor.

## Mimari

```
[Kaynaklar] → [Kripto Worker] → [coinhit postgres + redis] → [Osiris API vitrin] → [Küre UI]
  Binance         (Python)          (ortak depo)              /api/crypto/*         ↘ Pythia
  DefiLlama                          + sinyal bus                                    ↘ İçerik motoru
  on-chain                           (redis pub/sub)                                 ↘ İç sinyaller
  Whale/OFAC
```

Tek toplama noktası (worker) dış API'lere gider; herkes ortak depodan/vitrinden okur. Bu, rate-limit riskini tek noktada toplar ve mevcut çalışan servisleri (globe.coinhit.net, Pythia) bozmadan kademeli genişlemeye izin verir.

## Bileşenler

### 1. Kripto Worker
- Konum: `coinhit-engine/services/crypto-ingest/` (Python)
- Çekirdek: mevcut `binance-market-aggregator.py` mantığı
- Kaynaklar ve döngü aralığı:
  - Piyasa (Binance fiyat/hacim/dominance/fear&greed): 30sn
  - Türev (Binance/Bybit futures — funding rate, open interest, likidasyon): 1dk
  - On-chain whale (blockstream.info, Blockscout, Etherscan): 2dk
  - DeFi (DefiLlama — TVL, stablecoin mint/burn, köprü hareketleri): 10dk
  - Coğrafi/compliance (madencilik hashrate dağılımı, OFAC SDN, hack/exploit feed'leri): 30dk
- Kural motoru: eşik-tabanlı olay üretimi (whale > $X, funding uç değer, likidasyon kaskadı, OFAC eşleşme, TVL ani düşüş, stablecoin depeg)

### 2. Ortak Depo
- Mevcut `coinhit` postgres'te (pgvector/pg16, 127.0.0.1:5433) yeni `crypto` şeması:
  - `crypto.markets` — fiyat/hacim/dominance zaman serisi
  - `crypto.derivatives` — funding/OI/likidasyon
  - `crypto.defi` — TVL/stablecoin/köprü
  - `crypto.whale_txns` — büyük transferler
  - `crypto.geo_nodes` — borsa/madencilik coğrafi dağılım
  - `crypto.compliance_hits` — OFAC/sanction eşleşmeleri
  - `crypto.signals` — kural motorundan üretilen olaylar
- Dedicated redis (yeni veya `social_redis_1` paylaşımlı — kurulum sırasında karar verilecek): hot cache + `crypto.signals` pub/sub kanalı

### 3. Osiris API Vitrini
- `src/app/api/crypto/` genişletilir, alt rotalar:
  - `markets`, `derivatives`, `defi`, `whales`, `geo`, `compliance`, `signals`
- Tümü dış API'ye değil, postgres/redis'e bağlanır (hızlı, kararlı, worker'ın topladığı veriyi sunar)

### 4. Küre UI — "Kripto Modu"
- Haritada: balina transfer akışları, borsa/madencilik coğrafi katmanı, hashrate ısı haritası
- Paneller: piyasa derinliği, funding/likidasyon, DeFi TVL, canlı whale akışı, compliance uyarıları

### 5. Tüketici Entegrasyonları
- **Pythia**: mevcut `OSIRIS_URL` bağlantısı üzerinden `/api/crypto/*` feed'i MiroFish'e eklenir
- **İçerik motoru**: coinhit-engine, redis `crypto.signals` kanalına abone olur → curator/producer otomatik haber üretir
- **İç sinyaller**: `/api/crypto/signals` + kimlik doğrulamalı alarm endpoint'i

## Kademeli Kurulum

1. **Faz 1:** `crypto` şeması + worker (piyasa+balina) + `/api/crypto/markets`, `/api/crypto/whales` vitrin
2. **Faz 2:** türev+likidasyon + DeFi/stablecoin worker'ları + ilgili rotalar
3. **Faz 3:** coğrafi+compliance katmanı + Küre "Kripto Modu" UI
4. **Faz 4:** sinyal bus → Pythia feed entegrasyonu + içerik motoru aboneliği + iç alarmlar

Her faz bağımsız teslim edilebilir; mevcut Osiris/Pythia/coinhit-engine hiçbir fazda kesintiye uğramaz.

## Test Stratejisi

- Worker: kaynak parser'ları ve kural motoru için birim testleri
- Osiris rotaları: mevcut `vitest` altyapısı ile genişletme
- Her faz sonunda uçtan uca doğrulama: worker → db → API vitrin → UI/tüketici
