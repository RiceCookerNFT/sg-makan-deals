export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** A piece of text that may contain deals: an RSS article or a rendered page. */
export interface Article {
  url: string;
  title: string;
  sourceName: string;
  official: boolean;         // true for a brand's own page
  brandHint?: string;        // for official pages: whose page this is
  publishedAt?: string;      // 'YYYY-MM-DD'
  text: string;
}

/** What the AI returns for each deal (untrusted until validated). */
export interface RawDeal {
  brand?: string;
  title?: string;
  price_text?: string | null;
  deal_type?: string;
  scope?: string;            // 'all_outlets' | 'participating' | 'specific'
  locations?: string[];
  start_date?: string | null;
  end_date?: string | null;
  conditions?: string[];
  evidence?: string;
}

/** A deal that passed every check. */
export interface CleanDeal {
  brand: string;
  title: string;
  priceText: string | null;
  dealType: '1for1' | 'percent' | 'price' | 'freebie' | 'other';
  scope: 'all_outlets' | 'participating' | 'specific';
  locations: string[];
  startDate: string | null;
  endDate: string;
  endDateGuessed: boolean;
  conditions: string[];
  sourceUrl: string;
  sourceName: string;
  official: boolean;
}

export interface Outlet {
  name: string;
  lat: number;
  lng: number;
}

/** Database access: Cloudflare's D1 REST API in production, local D1 in tests. */
export interface Db {
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
}
