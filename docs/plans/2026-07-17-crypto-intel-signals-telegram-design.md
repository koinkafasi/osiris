# CoinHit Intelligence — Alt-Proje 1: Canlı İstihbarat Akışı + Telegram Bildirimi

**Tarih:** 2026-07-17
**Durum:** Onaylandı (brainstorming), implementasyon planı bekliyor

## Bağlam

Bu, daha büyük bir "CoinHit Intelligence" yol haritasının ilk alt-projesidir:

1. **Canlı istihbarat akışı + Telegram bildirimi** ← bu doküman
2. Akıllı para / kurum etiketleme (bilinen cüzdanları işaretleme)
3. Cüzdan ilişki grafiği (Neo4j + graph görselleştirme)
4. 3D küre / sinematik görsel motor (CesiumJS + Three.js)

Her alt-proje kendi spec → plan → implementation döngüsünden geçer. Bu doküman sadece 1. alt-projeyi kapsar.

Mevcut altyapı: `crypto-ingest` worker'ı zaten `crypto.signals` tablosuna `whale_alert`, `funding_extreme`, `liquidation_cascade` sinyalleri yazıyor (`services/signals.py`, her 60 saniyede bir `check_and_emit_signals()`). `severity` alanı `critical`/`warning` olarak ayrılmış. `_emit()` fonksiyonu DB'ye yazar (otoriter) ve Redis'e best-effort publish eder. Osiris tarafında `/api/crypto/signals` route'u var ama bearer-key ile korunuyor (Pythia'nın server-to-server tüketimi için) ve `CryptoPanel.tsx`'te hiç gösterilmiyor.

## Hedef

- Kritik sinyaller (severity=critical) oluştuğunda ekibe Telegram üzerinden anlık bildirim gitsin.
- CryptoPanel'de yeni bir "🚨 Canlı İstihbarat" kartı, kritik sinyalleri listelesin.
- Ekip üyeleri, kişi başı bot kurulumu yapmadan, panelden bir QR kod okutarak Telegram grubuna katılıp bildirimleri almaya başlayabilsin.

## Mimari

```
crypto-ingest/services/worker.py (60s interval)
  → check_and_emit_signals()
    → evaluate_whale / evaluate_funding_extreme / evaluate_liquidation_cascade
      → _emit(sig)
          ├─ DB INSERT crypto.signals              (mevcut, otoriter)
          ├─ Redis publish                          (mevcut, best-effort)
          └─ send_telegram_message(...)             (YENİ — sadece severity == "critical", best-effort)

osiris (Next.js)
  src/app/page.tsx (Server Component)
    → process.env.TELEGRAM_GROUP_INVITE_LINK okunur (sunucu tarafında)
    → QR SVG sunucuda üretilir (npm: qrcode)
    → <CryptoPanel inviteQrSvg={...} /> prop olarak geçilir

  src/components/CryptoPanel.tsx
    → yeni "🚨 Canlı İstihbarat" kartı
        - useCryptoFeed('signals-feed', 60000) ile son kritik sinyalleri çeker
        - başlıkta "📲 Ekibe Katıl" butonu → popover'da inviteQrSvg gösterir

  src/app/api/crypto/signals-feed/route.ts (YENİ)
    → diğer 8 route ile aynı desen (public, bearer key yok — sayfa zaten login arkasında)
    → crypto.signals tablosundan son 24 saatteki severity=critical satırları döner
    → MEVCUT /api/crypto/signals/route.ts'ye (Pythia'nın bearer-key'li tükettiği) dokunulmaz
```

## Bileşenler

### 1. `crypto-ingest/services/telegram.py` (yeni)

- `send_telegram_message(text: str) -> None`
- Telegram Bot API'ye düz `requests.post(f"https://api.telegram.org/bot{TOKEN}/sendMessage", ...)`.
- `TELEGRAM_BOT_TOKEN` ve `TELEGRAM_CHAT_ID` env'den okunur (`.env`, gitignored — mevcut `CRYPTO_DB_PASSWORD` vb. ile aynı desen).
- Best-effort: `try/except Exception`, hata sadece loglanır, hiçbir zaman yukarı fırlatılmaz.
- Token/chat-id boşsa fonksiyon sessizce no-op döner (özellik "kapalı" davranır, worker crash olmaz).
- Aynı dosyada `format_signal_message(sig: dict) -> str` yardımcı fonksiyonu: `signal_type`, `symbol`, `message` alanlarından okunabilir kısa bir metin üretir (emoji ile `signal_type`'a göre önek: 🐋 whale_alert, 📈 funding_extreme, ⚠️ liquidation_cascade).

### 2. `signals.py::_emit()` değişikliği

- DB insert'ten sonra: `if sig["severity"] == "critical": send_telegram_message(format_signal_message(sig))`.
- Mevcut dedup/cooldown mantığına (`_recently_signaled`, `_already_signaled_whale`) dokunulmaz — bir sinyal DB'ye kaç kere yazılırsa Telegram'a da o kadar gider (yani zaten dedup edilmiş sinyaller için ekstra bir dedup katmanı gerekmez).

### 3. `osiris/src/app/api/crypto/signals-feed/route.ts` (yeni)

- Diğer 8 crypto route'la birebir aynı desen: `GET`, DB'den sorgu, `Cache-Control: no-store`.
- Sorgu: `SELECT signal_type, severity, symbol, message, created_at FROM crypto.signals WHERE severity='critical' AND created_at > now() - interval '24 hours' ORDER BY created_at DESC LIMIT 20`.
- Auth yok (public route) — mevcut markets/whales/vb. route'larla tutarlı, çünkü koruma sayfa seviyesinde (`middleware.ts`) zaten var.

### 4. `CryptoPanel.tsx` değişikliği

- Yeni `useCryptoFeed<SignalsFeedResponse>('signals-feed', 60000)` çağrısı.
- Yeni kart: "🚨 Canlı İstihbarat" — `rowLimit()` yardımcı fonksiyonuyla diğer kartlarla aynı liste deseninde satırlar.
- Kart başlığında "📲 Ekibe Katıl" ikonu/buton — tıklanınca `inviteQrSvg` prop'unu bir popover'da gösterir.
- `CryptoPanel` bileşenine yeni bir opsiyonel prop: `inviteQrSvg?: string` (server'dan gelen SVG markup, `dangerouslySetInnerHTML` ile render edilir — XSS riski yok çünkü içerik bizim kendi sunucu tarafımızda `qrcode` paketiyle üretiliyor, kullanıcı girdisi değil).

### 5. Telegram grup + QR daveti (operasyonel + güvenlik)

- Sen (kullanıcı) Telegram'da özel bir grup açıp yeni botu üye olarak eklersin. Bot bu gruba mesaj atabilmesi için üye olması yeterli (admin şart değil).
- Grubun davet linkini (`t.me/+xxxxx`) alıp Osiris `.env`'ine `TELEGRAM_GROUP_INVITE_LINK` olarak eklersin.
- **Güvenlik kararı:** Bu link asla yeni bir public API route ile servis edilmez ve asla `NEXT_PUBLIC_` önekiyle client bundle'a gömülmez. `/api/*` route'ları login middleware'inin matcher'ından muaf olduğu için (mevcut mimari), bir API route üzerinden servis etmek login ekranını by-pass eder. Bunun yerine `page.tsx` (Server Component) env'i sunucu tarafında okur, QR'ı sunucuda SVG'ye çevirir, sadece render edilmiş SVG'yi `CryptoPanel`'e prop olarak geçirir. Sonuç: davet linki hiçbir zaman network üzerinden ayrı bir yanıt olarak dışarı çıkmaz — sadece login arkasındaki sayfa HTML'inde (SVG içine kodlanmış halde) bulunur.
- **Rotasyon:** Link sızarsa, Telegram'dan grup için yeni davet linki üretip eskisini iptal edersin, `.env`'i güncelleyip PM2 restart edersin — diğer secret rotasyonlarıyla aynı prosedür.

## Veri Akışı

1. Worker 60 saniyede bir sinyalleri değerlendirir.
2. Kritik bir sinyal oluşursa: DB'ye yazılır → Redis'e publish edilir → Telegram grubuna mesaj gider (best-effort, sıralı ama birbirini bloklamaz).
3. Bağımsız olarak, Osiris `signals-feed` route'u aynı `crypto.signals` tablosunu 60 saniyede bir okur, panel kartını günceller.
4. Ekip üyesi panelde QR'ı okutur → Telegram grubuna katılır → sonraki tüm kritik sinyalleri gruptan görür.

## Hata Yönetimi

- Telegram API'nin çökmesi/timeout olması sinyal üretimini asla etkilemez (try/except + log, mevcut Redis best-effort deseniyle birebir aynı prensip).
- Bot token/chat-id eksikse özellik sessizce devre dışı kalır (crash yok).
- `signals-feed` route'unda DB hatası olursa diğer 8 route'la aynı desende `{ signals: [], error: 'Failed' }` + 500 döner (panel diğer kartlar gibi hatayı sessizce yutar).

## Test

- `test_telegram.py` (yeni, crypto-ingest): `send_telegram_message` — `requests.post` mock'lanarak başarı ve hata (exception, non-200 response) senaryoları; token/chat-id boşken no-op olduğu.
- `test_signals.py` içine ek: `_emit()`'in `severity="critical"` sinyalde Telegram'ı çağırdığı, `severity="warning"` sinyalde ÇAĞIRMADIĞI (mock ile doğrulanır).
- `signals-feed/route.test.ts` (yeni, osiris): mevcut 8 route testiyle aynı kalıpta — mock DB, boş sonuç, DB hatası senaryosu, `severity='critical'` filtresinin sorguya yansıdığının doğrulanması.
- QR/env okuma kısmı için ayrı bir otomatik test öngörülmüyor (statik sunucu-taraflı render, manuel smoke-test ile doğrulanacak: panel açılıp QR görünüyor mu, telefon ile okutulup gruba katılım çalışıyor mu).

## Kapsam Dışı (bu alt-proje için)

- Bireysel abonelik/DM modeli (Alt-proje 1 sadece grup daveti kapsıyor; ileride istenirse ayrı bir alt-proje olarak ele alınabilir).
- Sinyal türü/eşik bazlı ince ayar UI'ı (şu an sadece `severity=critical` sabit filtresi var).
- Yol haritasındaki 2-3-4. alt-projeler (akıllı para etiketleme, cüzdan grafiği, 3D küre) — bu doküman kapsamı dışında, ayrı spec'lerle ele alınacak.
