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
  src/app/actions/telegram-invite.ts (YENİ — Server Action, 'use server')
    → next/headers cookies() ile osiris_session cookie'sini okur
    → verifySessionToken(token, process.env.SESSION_SECRET) ile doğrular (middleware'deki ile birebir aynı kontrol)
    → geçersizse { error } döner; geçerliyse process.env.TELEGRAM_GROUP_INVITE_LINK'i okuyup
      qrcode paketiyle SVG üretir, { svg } döner

  src/components/CryptoPanel.tsx ('use client')
    → yeni "🚨 Canlı İstihbarat" kartı
        - useCryptoFeed('signals-feed', 60000) ile son kritik sinyalleri çeker
        - başlıkta "📲 Ekibe Katıl" butonu → tıklanınca getTelegramInviteQr() server action'ını çağırır,
          dönen SVG'yi popover'da gösterir

  src/app/api/crypto/signals-feed/route.ts (YENİ)
    → diğer 8 route ile aynı desen (public, bearer key yok — sayfa zaten login arkasında)
    → crypto.signals tablosundan son 24 saatteki severity=critical satırları döner
    → MEVCUT /api/crypto/signals/route.ts'ye (Pythia'nın bearer-key'li tükettiği) dokunulmaz
```

**Not (brainstorming sonrası düzeltme):** İlk tasarımda `page.tsx`'in bir Server Component olduğu ve env'i doğrudan okuyup prop olarak geçebileceği varsayılmıştı. Plan yazarken kodu kontrol ettim — `page.tsx` aslında `'use client'` ile başlıyor (React state/hook kullanan bir Dashboard component'i). Next.js App Router'da bir Client Component'e üst bir Server Component'ten (layout.tsx) özel prop enjekte etmenin (page.tsx özelinde) yolu yok. Bunun yerine **Server Action** kullanmak hem daha temiz hem daha güvenli: davet linki hâlâ hiçbir zaman bir GET route'unda yer almıyor, ÜSTELİK middleware'in sayfa-seviyesi korumasından bağımsız olarak action'ın kendisi de session cookie'sini ayrıca doğruluyor (defense-in-depth).

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

### 4. `src/app/actions/telegram-invite.ts` (yeni, Server Action)

- Dosya başında `'use server'`.
- `getTelegramInviteQr(): Promise<{ svg: string } | { error: string }>`.
- `next/headers`'dan `cookies()` ile `osiris_session` cookie'sini okur (mevcut `SESSION_COOKIE_NAME` sabiti).
- `verifySessionToken(token, process.env.SESSION_SECRET)` ile doğrular (middleware'deki kontrolle birebir aynı — bkz. `src/middleware.ts:11-19`). Geçersiz/eksikse `{ error: 'Unauthorized' }` döner.
- Geçerliyse `process.env.TELEGRAM_GROUP_INVITE_LINK` okunur; boşsa `{ error: 'Not configured' }`. Doluysa `qrcode` paketinin `QRCode.toString(link, { type: 'svg', margin: 1 })` fonksiyonuyla SVG üretilip `{ svg }` döner.
- Yeni npm bağımlılığı: `qrcode` (+ `@types/qrcode` dev bağımlılığı).

### 5. `CryptoPanel.tsx` değişikliği

- Yeni `useCryptoFeed<SignalsFeedResponse>('signals-feed', 60000)` çağrısı.
- Yeni kart: "🚨 Canlı İstihbarat" — `rowLimit()` yardımcı fonksiyonuyla diğer kartlarla aynı liste deseninde satırlar.
- Kart başlığında "📲 Ekibe Katıl" ikonu/buton — tıklanınca `getTelegramInviteQr()` server action'ı çağrılır (client component'ten server action'ı doğrudan import edip `await` ile çağırmak Next.js'in desteklediği standart desendir, ekstra bir API route gerekmez), dönen `{ svg }` bir popover'da `dangerouslySetInnerHTML` ile render edilir (XSS riski yok — içerik bizim `qrcode` paketiyle sunucuda ürettiğimiz SVG, kullanıcı girdisi değil), `{ error }` dönerse popover'da kısa bir hata mesajı gösterilir.

### 6. Telegram grup + QR daveti (operasyonel + güvenlik)

- Sen (kullanıcı) Telegram'da özel bir grup açıp yeni botu üye olarak eklersin. Bot bu gruba mesaj atabilmesi için üye olması yeterli (admin şart değil).
- Grubun davet linkini (`t.me/+xxxxx`) alıp Osiris `.env`'ine `TELEGRAM_GROUP_INVITE_LINK` olarak eklersin.
- **Güvenlik kararı:** Bu link asla yeni bir public GET API route ile servis edilmez ve asla `NEXT_PUBLIC_` önekiyle client bundle'a gömülmez. Server Action, middleware'in sayfa-seviyesi korumasından BAĞIMSIZ olarak session cookie'sini kendi içinde ayrıca doğruluyor (defense-in-depth) — yani action'ın kendi URL'i teorik olarak doğrudan çağrılsa bile (Next.js server action'ları internal bir POST endpoint'i üzerinden çalışır) geçerli bir oturum çerezi olmadan hiçbir şey dönmez.
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
- `telegram-invite.test.ts` (yeni, osiris): `getTelegramInviteQr()` — `next/headers` `cookies()` ve `verifySessionToken` mock'lanarak (a) geçersiz/eksik cookie'de `{ error: 'Unauthorized' }`, (b) geçerli cookie ama env eksikken `{ error: 'Not configured' }`, (c) geçerli cookie + env doluyken `{ svg }` (SVG string içeriği) döndüğü doğrulanır.
- Manuel smoke-test (otomatik testlerin doğrulayamadığı uçtan uca akış): panel açılıp QR görünüyor mu, telefon ile okutulup Telegram grubuna katılım gerçekten çalışıyor mu.

## Kapsam Dışı (bu alt-proje için)

- Bireysel abonelik/DM modeli (Alt-proje 1 sadece grup daveti kapsıyor; ileride istenirse ayrı bir alt-proje olarak ele alınabilir).
- Sinyal türü/eşik bazlı ince ayar UI'ı (şu an sadece `severity=critical` sabit filtresi var).
- Yol haritasındaki 2-3-4. alt-projeler (akıllı para etiketleme, cüzdan grafiği, 3D küre) — bu doküman kapsamı dışında, ayrı spec'lerle ele alınacak.
