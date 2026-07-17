'use client';

import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import type { LucideIcon } from 'lucide-react';
import {
  Bitcoin, TrendingUp, TrendingDown, ChevronDown, ChevronUp,
  Zap, Waves, Flame, Layers, Coins, Globe2, ShieldAlert, Maximize2, Minimize2,
} from 'lucide-react';

// ── Response shapes — mirrored from src/app/api/crypto/*/route.ts ──
interface MarketRow {
  symbol: string;
  price_usd: number;
  volume_24h_usd: number | null;
  change_24h_pct: number | null;
  btc_dominance_pct: number | null;
  fear_greed_index: number | null;
  collected_at: string;
}
interface DerivativeRow {
  symbol: string;
  funding_rate: number | null;
  mark_price: number;
  open_interest_usd: number | null;
  collected_at: string;
}
interface WhaleRow {
  chain: string;
  tx_hash: string;
  value_usd: number;
  from_address: string | null;
  to_address: string | null;
  observed_at: string;
}
interface LiquidationRow {
  symbol: string;
  side: string;
  value_usd: number;
  price_usd: number;
  observed_at: string;
}
interface DefiRow {
  protocol: string;
  chain: string | null;
  category: string | null;
  tvl_usd: number;
  collected_at: string;
}
interface StablecoinRow {
  symbol: string;
  circulating_usd: number;
  net_change_usd: number | null;
  collected_at: string;
}
interface GeoRow {
  kind: string;
  country: string;
  metric_value: number;
  collected_at: string;
}
interface ComplianceRow {
  address: string;
  chain: string;
  list_name: string;
  matched_whale_tx_hash: string | null;
  observed_at: string;
}

interface MarketsResponse { markets: MarketRow[]; error?: string }
interface DerivativesResponse { derivatives: DerivativeRow[]; error?: string }
interface WhalesResponse { whales: WhaleRow[]; error?: string }
interface LiquidationsResponse { liquidations: LiquidationRow[]; error?: string }
interface DefiResponse { defi: DefiRow[]; error?: string }
interface StablecoinsResponse { stablecoins: StablecoinRow[]; error?: string }
interface GeoResponse { geo: GeoRow[]; error?: string }
interface ComplianceResponse { compliance: ComplianceRow[]; error?: string }

type SectionKey = 'markets' | 'derivatives' | 'whales' | 'liquidations' | 'defi' | 'stablecoins' | 'geo' | 'compliance';

const SECTIONS: { key: SectionKey; label: string; icon: LucideIcon }[] = [
  { key: 'markets', label: 'MARKETS', icon: TrendingUp },
  { key: 'derivatives', label: 'DERIVATIVES', icon: Zap },
  { key: 'whales', label: 'WHALES', icon: Waves },
  { key: 'liquidations', label: 'LIQUIDATIONS', icon: Flame },
  { key: 'defi', label: 'DEFI', icon: Layers },
  { key: 'stablecoins', label: 'STABLES', icon: Coins },
  { key: 'geo', label: 'GEO', icon: Globe2 },
  { key: 'compliance', label: 'COMPLIANCE', icon: ShieldAlert },
];

function useCryptoFeed<T>(endpoint: string, intervalMs = 30000): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let mounted = true;
    const fetchData = () => {
      fetch(`/api/crypto/${endpoint}`)
        .then((r) => r.json())
        .then((d: T) => { if (mounted) setData(d); })
        .catch(() => { /* keep last known-good data on a transient failure */ });
    };
    fetchData();
    const id = setInterval(fetchData, intervalMs);
    return () => { mounted = false; clearInterval(id); };
  }, [endpoint, intervalMs]);
  return data;
}

// ── Formatting helpers ──
function formatPrice(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1000) return `$${v.toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
  if (abs >= 1) return `$${v.toFixed(2)}`;
  if (abs >= 0.0001) return `$${v.toFixed(6)}`;
  return `$${v.toExponential(2)}`;
}
function formatUsd(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}
function formatPct(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`;
}
function formatFunding(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return '—';
  return `${(v * 100).toFixed(4)}%`;
}
function truncateAddr(v: string | null | undefined): string {
  if (!v) return '—';
  return v.length > 12 ? `${v.slice(0, 6)}...${v.slice(-4)}` : v;
}

function EmptyRow({ label }: { label: string }) {
  return <div className="text-center py-3 text-[10px] font-mono text-[var(--text-muted)]">{label}</div>;
}

function Row({ left, right, rightColor }: { left: React.ReactNode; right: React.ReactNode; rightColor?: string }) {
  return (
    <div className="flex items-center justify-between py-1.5 px-2 rounded hover:bg-[var(--hover-accent)] transition-colors">
      <span className="text-[10px] font-mono text-[var(--text-secondary)] tracking-wide truncate pr-2">{left}</span>
      <span className="text-[10px] font-mono font-bold tabular-nums whitespace-nowrap" style={{ color: rightColor }}>{right}</span>
    </div>
  );
}

export default function CryptoPanel() {
  const [expanded, setExpanded] = useState(true);
  const [maximized, setMaximized] = useState(false);
  const [activeSection, setActiveSection] = useState<SectionKey>('markets');

  // Portal only renders on the client
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Show more rows per section when maximized — there's room for it.
  const rowLimit = (n: number) => (maximized ? n * 3 : n);

  const markets = useCryptoFeed<MarketsResponse>('markets', 30000);
  const derivatives = useCryptoFeed<DerivativesResponse>('derivatives', 60000);
  const whales = useCryptoFeed<WhalesResponse>('whales', 60000);
  const liquidations = useCryptoFeed<LiquidationsResponse>('liquidations', 60000);
  const defi = useCryptoFeed<DefiResponse>('defi', 300000);
  const stablecoins = useCryptoFeed<StablecoinsResponse>('stablecoins', 300000);
  const geo = useCryptoFeed<GeoResponse>('geo', 3600000);
  const compliance = useCryptoFeed<ComplianceResponse>('compliance', 300000);

  const loadedBySection: Record<SectionKey, boolean> = {
    markets: markets !== null,
    derivatives: derivatives !== null,
    whales: whales !== null,
    liquidations: liquidations !== null,
    defi: defi !== null,
    stablecoins: stablecoins !== null,
    geo: geo !== null,
    compliance: compliance !== null,
  };

  const firstMarket = markets?.markets?.[0];

  const content = (
    <div className={`glass-panel p-3 transition-all duration-300 flex flex-col ${maximized ? 'fixed inset-4 z-[9999] bg-[#0a0a09]/95 backdrop-blur-3xl' : ''}`}>
      <button onClick={() => setExpanded(!expanded)} className="flex items-center justify-between w-full mb-2">
        <div className="flex items-center gap-2">
          <Bitcoin className="w-3.5 h-3.5 text-[var(--gold-primary)]" />
          <span className="hud-text text-[12px] text-[var(--text-primary)]">CRYPTO INTEL</span>
          <span className="gotham-tag gotham-tag--low" style={{ fontSize: '7px', padding: '1px 4px' }}>LIVE</span>
        </div>
        <div className="flex items-center gap-2">
          <div className="w-1.5 h-1.5 rounded-full bg-[var(--alert-green)] animate-osiris-pulse" />
          <button onClick={(e) => { e.stopPropagation(); setMaximized(!maximized); if (!expanded && !maximized) setExpanded(true); }} className="hover:text-white transition-colors" title={maximized ? 'Restore' : 'Maximize'}>
            {maximized ? <Minimize2 className="w-3.5 h-3.5 text-[var(--text-muted)]" /> : <Maximize2 className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
          </button>
          {expanded ? <ChevronUp className="w-3.5 h-3.5 text-[var(--text-muted)]" /> : <ChevronDown className="w-3.5 h-3.5 text-[var(--text-muted)]" />}
        </div>
      </button>

      <AnimatePresence>
        {expanded && (
          <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.2 }}>
            {/* Sentiment strip */}
            {firstMarket && (firstMarket.fear_greed_index !== null || firstMarket.btc_dominance_pct !== null) && (
              <div className="flex items-center justify-between mb-2 px-2 py-1.5 rounded border border-[var(--border-primary)] bg-[var(--hover-accent)]">
                <div className="flex items-center gap-1.5">
                  <span className="text-[8px] font-mono tracking-widest text-[var(--text-muted)]">BTC DOM</span>
                  <span className="text-[10px] font-mono font-bold text-[var(--gold-primary)]">
                    {firstMarket.btc_dominance_pct !== null ? `${firstMarket.btc_dominance_pct.toFixed(1)}%` : '—'}
                  </span>
                </div>
                <div className="flex items-center gap-1.5">
                  <span className="text-[8px] font-mono tracking-widest text-[var(--text-muted)]">FEAR &amp; GREED</span>
                  <span className="text-[10px] font-mono font-bold text-[var(--gold-primary)]">
                    {firstMarket.fear_greed_index ?? '—'}
                  </span>
                </div>
              </div>
            )}

            {/* Section Tabs */}
            <div className="flex gap-0.5 mb-2 overflow-x-auto">
              {SECTIONS.map((s) => {
                const Icon = s.icon;
                return (
                  <button key={s.key} onClick={() => setActiveSection(s.key)}
                    className={`flex items-center gap-1 px-2.5 py-1.5 rounded text-[9px] font-mono tracking-wider whitespace-nowrap transition-all ${activeSection === s.key ? 'bg-[var(--hover-accent)] text-[var(--gold-primary)] border border-[var(--border-primary)]' : 'text-[var(--text-muted)] hover:text-[var(--text-secondary)] border border-transparent'}`}>
                    <Icon className="w-3 h-3" />
                    {s.label}
                  </button>
                );
              })}
            </div>

            {/* Content */}
            <div className={`space-y-0.5 overflow-y-auto styled-scrollbar ${maximized ? 'flex-1' : 'max-h-56'}`}>
              {!loadedBySection[activeSection] && <EmptyRow label="Yükleniyor..." />}

              {activeSection === 'markets' && markets && (
                markets.markets.length
                  ? markets.markets.slice(0, rowLimit(12)).map((m) => (
                      <Row key={m.symbol}
                        left={m.symbol}
                        right={`${formatPrice(m.price_usd)} (${formatPct(m.change_24h_pct)})`}
                        rightColor={(m.change_24h_pct ?? 0) >= 0 ? 'var(--alert-green)' : 'var(--alert-red)'} />
                    ))
                  : <EmptyRow label="Veri yok" />
              )}

              {activeSection === 'derivatives' && derivatives && (
                derivatives.derivatives.length
                  ? derivatives.derivatives.slice(0, rowLimit(12)).map((d) => (
                      <Row key={d.symbol}
                        left={d.symbol}
                        right={`fund ${formatFunding(d.funding_rate)} · OI ${formatUsd(d.open_interest_usd)}`}
                        rightColor={(d.funding_rate ?? 0) >= 0 ? 'var(--alert-green)' : 'var(--alert-red)'} />
                    ))
                  : <EmptyRow label="Veri yok" />
              )}

              {activeSection === 'whales' && whales && (
                whales.whales.length
                  ? whales.whales.slice(0, rowLimit(15)).map((w) => (
                      <Row key={w.tx_hash}
                        left={`${w.chain} → ${truncateAddr(w.to_address)}`}
                        right={formatUsd(w.value_usd)} />
                    ))
                  : <EmptyRow label="Son 24 saatte büyük transfer yok" />
              )}

              {activeSection === 'liquidations' && liquidations && (
                liquidations.liquidations.length
                  ? liquidations.liquidations.slice(0, rowLimit(15)).map((l, i) => (
                      <Row key={`${l.symbol}-${l.observed_at}-${i}`}
                        left={`${l.symbol} ${l.side}`}
                        right={formatUsd(l.value_usd)}
                        rightColor={l.side?.toLowerCase() === 'short' ? 'var(--alert-green)' : 'var(--alert-red)'} />
                    ))
                  : <EmptyRow label="Son 1 saatte likidasyon yok" />
              )}

              {activeSection === 'defi' && defi && (
                defi.defi.length
                  ? defi.defi.slice(0, rowLimit(15)).map((p) => (
                      <Row key={p.protocol}
                        left={`${p.protocol}${p.category ? ` · ${p.category}` : ''}`}
                        right={formatUsd(p.tvl_usd)} />
                    ))
                  : <EmptyRow label="Veri yok" />
              )}

              {activeSection === 'stablecoins' && stablecoins && (
                stablecoins.stablecoins.length
                  ? stablecoins.stablecoins.slice(0, rowLimit(12)).map((s) => (
                      <Row key={s.symbol}
                        left={s.symbol}
                        right={`${formatUsd(s.circulating_usd)} (${s.net_change_usd !== null && s.net_change_usd >= 0 ? '+' : ''}${formatUsd(s.net_change_usd)})`}
                        rightColor={(s.net_change_usd ?? 0) >= 0 ? 'var(--alert-green)' : 'var(--alert-red)'} />
                    ))
                  : <EmptyRow label="Veri yok" />
              )}

              {activeSection === 'geo' && geo && (
                geo.geo.length
                  ? geo.geo.slice(0, rowLimit(12)).map((g, i) => (
                      <Row key={`${g.kind}-${g.country}-${i}`}
                        left={`${g.country} (${g.kind.replace(/_/g, ' ')})`}
                        right={`${g.metric_value}%`} />
                    ))
                  : <EmptyRow label="Veri yok" />
              )}

              {activeSection === 'compliance' && compliance && (
                <>
                  <div className="text-[9px] font-mono text-[var(--text-muted)] px-1 pb-1.5 leading-tight">
                    Başlangıç listesi — kapsamlı OFAC/SDN taraması değildir
                  </div>
                  {compliance.compliance.length
                    ? compliance.compliance.slice(0, rowLimit(15)).map((c, i) => (
                        <Row key={`${c.address}-${c.observed_at}-${i}`}
                          left={`${c.chain} · ${c.list_name}`}
                          right={truncateAddr(c.address)}
                          rightColor="var(--alert-red)" />
                      ))
                    : <EmptyRow label="Eşleşme yok (son 24s)" />}
                </>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );

  if (maximized && mounted && typeof document !== 'undefined') {
    return createPortal(content, document.body);
  }

  return content;
}
