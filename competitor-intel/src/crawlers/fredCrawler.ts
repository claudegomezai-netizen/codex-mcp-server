/**
 * FRED Economic Data + CNN Fear & Greed Index Crawler
 * Fetches key economic indicators from FRED API and market sentiment from CNN
 */

import type { FredSeries, FredSeriesPoint, FearGreedData, MarketIndicators } from '../config/competitors.js';
import { getMarketIndicators, saveMarketIndicators } from '../services/blobStore.js';

const FRED_BASE = 'https://api.stlouisfed.org/fred/series/observations';

interface FredSeriesConfig {
  id: string;
  label: string;
  unit: string;
  category: string;
  source_url: string;
}

const FRED_SERIES_CONFIG: FredSeriesConfig[] = [
  // ── Volatility & Risk ──
  { id: 'VIXCLS', label: 'VIX (Volatility Index)', unit: 'Index', category: 'Volatility & Risk', source_url: 'https://fred.stlouisfed.org/series/VIXCLS' },
  { id: 'STLFSI4', label: 'Financial Stress Index', unit: 'Index', category: 'Volatility & Risk', source_url: 'https://fred.stlouisfed.org/series/STLFSI4' },

  // ── Interest Rates & Yields ──
  { id: 'DGS10', label: '10-Year Treasury Yield', unit: '%', category: 'Interest Rates', source_url: 'https://fred.stlouisfed.org/series/DGS10' },
  { id: 'DGS2', label: '2-Year Treasury Yield', unit: '%', category: 'Interest Rates', source_url: 'https://fred.stlouisfed.org/series/DGS2' },
  { id: 'DGS30', label: '30-Year Treasury Yield', unit: '%', category: 'Interest Rates', source_url: 'https://fred.stlouisfed.org/series/DGS30' },
  { id: 'DGS5', label: '5-Year Treasury Yield', unit: '%', category: 'Interest Rates', source_url: 'https://fred.stlouisfed.org/series/DGS5' },
  { id: 'DTB3', label: '3-Month T-Bill Rate', unit: '%', category: 'Interest Rates', source_url: 'https://fred.stlouisfed.org/series/DTB3' },
  { id: 'FEDFUNDS', label: 'Fed Funds Rate', unit: '%', category: 'Interest Rates', source_url: 'https://fred.stlouisfed.org/series/FEDFUNDS' },
  { id: 'DPRIME', label: 'Bank Prime Loan Rate', unit: '%', category: 'Interest Rates', source_url: 'https://fred.stlouisfed.org/series/DPRIME' },

  // ── Credit Spreads ──
  { id: 'BAMLH0A0HYM2', label: 'High Yield OAS Spread', unit: '%', category: 'Credit Spreads', source_url: 'https://fred.stlouisfed.org/series/BAMLH0A0HYM2' },
  { id: 'BAMLC0A4CBBB', label: 'BBB Corporate Spread', unit: '%', category: 'Credit Spreads', source_url: 'https://fred.stlouisfed.org/series/BAMLC0A4CBBB' },
  { id: 'BAMLC0A1CAAA', label: 'AAA Corporate Spread', unit: '%', category: 'Credit Spreads', source_url: 'https://fred.stlouisfed.org/series/BAMLC0A1CAAA' },
  { id: 'T10Y2Y', label: 'Yield Curve (10Y-2Y)', unit: '%', category: 'Credit Spreads', source_url: 'https://fred.stlouisfed.org/series/T10Y2Y' },
  { id: 'T10YFF', label: 'Term Spread (10Y-FFR)', unit: '%', category: 'Credit Spreads', source_url: 'https://fred.stlouisfed.org/series/T10YFF' },

  // ── Inflation & Prices ──
  { id: 'T10YIE', label: '10-Year Breakeven Inflation', unit: '%', category: 'Inflation', source_url: 'https://fred.stlouisfed.org/series/T10YIE' },
  { id: 'T5YIE', label: '5-Year Breakeven Inflation', unit: '%', category: 'Inflation', source_url: 'https://fred.stlouisfed.org/series/T5YIE' },
  { id: 'CPIAUCSL', label: 'CPI (All Urban Consumers)', unit: 'Index', category: 'Inflation', source_url: 'https://fred.stlouisfed.org/series/CPIAUCSL' },
  { id: 'PCEPI', label: 'PCE Price Index', unit: 'Index', category: 'Inflation', source_url: 'https://fred.stlouisfed.org/series/PCEPI' },

  // ── Commodities ──
  { id: 'DCOILWTICO', label: 'Crude Oil (WTI)', unit: '$/bbl', category: 'Commodities', source_url: 'https://fred.stlouisfed.org/series/DCOILWTICO' },
  { id: 'DCOILBRENTEU', label: 'Crude Oil (Brent)', unit: '$/bbl', category: 'Commodities', source_url: 'https://fred.stlouisfed.org/series/DCOILBRENTEU' },
  { id: 'DHHNGSP', label: 'Natural Gas (Henry Hub)', unit: '$/MMBtu', category: 'Commodities', source_url: 'https://fred.stlouisfed.org/series/DHHNGSP' },
  { id: 'GOLDAMGBD228NLBM', label: 'Gold Price (London Fix)', unit: '$/oz', category: 'Commodities', source_url: 'https://fred.stlouisfed.org/series/GOLDAMGBD228NLBM' },
  { id: 'DEXUSEU', label: 'EUR/USD Exchange Rate', unit: 'Rate', category: 'Currencies', source_url: 'https://fred.stlouisfed.org/series/DEXUSEU' },
  { id: 'DEXJPUS', label: 'JPY/USD Exchange Rate', unit: '¥/$', category: 'Currencies', source_url: 'https://fred.stlouisfed.org/series/DEXJPUS' },
  { id: 'DTWEXBGS', label: 'US Dollar Index (Broad)', unit: 'Index', category: 'Currencies', source_url: 'https://fred.stlouisfed.org/series/DTWEXBGS' },

  // ── Money & Liquidity ──
  { id: 'WALCL', label: 'Fed Balance Sheet (Total)', unit: '$M', category: 'Liquidity', source_url: 'https://fred.stlouisfed.org/series/WALCL' },
  { id: 'RRPONTSYD', label: 'Overnight Reverse Repo', unit: '$B', category: 'Liquidity', source_url: 'https://fred.stlouisfed.org/series/RRPONTSYD' },

  // ── Labor Market ──
  { id: 'UNRATE', label: 'Unemployment Rate', unit: '%', category: 'Labor Market', source_url: 'https://fred.stlouisfed.org/series/UNRATE' },
  { id: 'ICSA', label: 'Initial Jobless Claims', unit: 'K', category: 'Labor Market', source_url: 'https://fred.stlouisfed.org/series/ICSA' },

  // ── Housing ──
  { id: 'MORTGAGE30US', label: '30-Year Mortgage Rate', unit: '%', category: 'Housing', source_url: 'https://fred.stlouisfed.org/series/MORTGAGE30US' },
  { id: 'CSUSHPINSA', label: 'S&P/Case-Shiller Home Price', unit: 'Index', category: 'Housing', source_url: 'https://fred.stlouisfed.org/series/CSUSHPINSA' },

  // ── Economic Activity ──
  { id: 'INDPRO', label: 'Industrial Production', unit: 'Index', category: 'Economic Activity', source_url: 'https://fred.stlouisfed.org/series/INDPRO' },
  { id: 'RSAFS', label: 'Retail Sales', unit: '$M', category: 'Economic Activity', source_url: 'https://fred.stlouisfed.org/series/RSAFS' },
  { id: 'UMCSENT', label: 'Consumer Sentiment (UMich)', unit: 'Index', category: 'Economic Activity', source_url: 'https://fred.stlouisfed.org/series/UMCSENT' },
];

async function fetchFredSeries(seriesId: string, apiKey: string): Promise<FredSeriesPoint[]> {
  const endDate = new Date().toISOString().split('T')[0];
  const startDate = new Date(Date.now() - 180 * 86400000).toISOString().split('T')[0]; // ~6 months

  const url = `${FRED_BASE}?series_id=${seriesId}&api_key=${apiKey}&file_type=json&observation_start=${startDate}&observation_end=${endDate}&sort_order=desc&limit=90`;

  const res = await fetch(url);
  if (!res.ok) {
    console.warn(`[FRED] Failed to fetch ${seriesId}: ${res.status}`);
    return [];
  }

  const data = await res.json();
  if (!data.observations) return [];

  return data.observations
    .filter((o: any) => o.value !== '.')
    .map((o: any) => ({
      date: o.date,
      value: parseFloat(o.value),
    }))
    .reverse(); // chronological order
}

async function fetchFearGreed(): Promise<FearGreedData | null> {
  try {
    const res = await fetch('https://production.dataviz.cnn.io/index/fearandgreed/graphdata/', {
      headers: { 'User-Agent': 'CompetitorIntelDashboard/1.0' },
    });
    if (!res.ok) {
      console.warn(`[FearGreed] Failed: ${res.status}`);
      return null;
    }

    const data = await res.json();
    const fg = data.fear_and_greed;
    if (!fg) return null;

    return {
      score: Math.round(fg.score),
      rating: fg.rating,
      previous_close: Math.round(fg.previous_close),
      one_week_ago: Math.round(fg.previous_1_week),
      one_month_ago: Math.round(fg.previous_1_month),
      one_year_ago: Math.round(fg.previous_1_year),
      updated_at: new Date().toISOString(),
    };
  } catch (err) {
    console.warn('[FearGreed] Error:', err);
    return null;
  }
}

export async function crawlMarketIndicators(): Promise<number> {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    console.warn('[FRED] FRED_API_KEY not set, skipping FRED data');
  }

  const fredSeries: FredSeries[] = [];

  if (apiKey) {
    // Process in batches of 5 with 600ms delay to stay under FRED 120/min limit
    for (let i = 0; i < FRED_SERIES_CONFIG.length; i++) {
      const config = FRED_SERIES_CONFIG[i];
      try {
        const points = await fetchFredSeries(config.id, apiKey);
        if (points.length > 0) {
          fredSeries.push({
            series_id: config.id,
            label: config.label,
            unit: config.unit,
            category: config.category,
            source_url: config.source_url,
            latest_value: points[points.length - 1].value,
            latest_date: points[points.length - 1].date,
            data_points: points,
          });
        }
      } catch (err) {
        console.warn(`[FRED] Error fetching ${config.id}:`, err);
      }
      // Rate limit: pause every 5 requests (600ms × ceil(33/5) ≈ 4.2s total, well under 120/min)
      if ((i + 1) % 5 === 0 && i < FRED_SERIES_CONFIG.length - 1) {
        await new Promise(r => setTimeout(r, 600));
      }
    }
  }

  const fearGreed = await fetchFearGreed();

  // Calculate yield spread (10Y - 2Y) — only if from matching dates
  const t10y = fredSeries.find(s => s.series_id === 'DGS10');
  const t2y = fredSeries.find(s => s.series_id === 'DGS2');
  let yieldSpread: number | null = null;
  if (t10y && t2y) {
    if (t10y.latest_date === t2y.latest_date) {
      yieldSpread = parseFloat((t10y.latest_value - t2y.latest_value).toFixed(2));
    } else {
      // Use T10Y2Y series directly if available (already computed by FRED)
      const t10y2y = fredSeries.find(s => s.series_id === 'T10Y2Y');
      yieldSpread = t10y2y ? t10y2y.latest_value : parseFloat((t10y.latest_value - t2y.latest_value).toFixed(2));
    }
  }

  const indicators: MarketIndicators = {
    fred_series: fredSeries,
    fear_greed: fearGreed,
    yield_spread: yieldSpread,
    updated_at: new Date().toISOString(),
  };

  await saveMarketIndicators(indicators);
  return fredSeries.length + (fearGreed ? 1 : 0);
}
