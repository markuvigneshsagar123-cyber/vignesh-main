import express from "express";
import { createServer as createViteServer } from "vite";
import axios from "axios";

// Simple in-memory cache
const cache: Record<string, { data: any; timestamp: number }> = {};
const CACHE_TTL = 60 * 1000; // 1 minute

function getCachedData(key: string) {
  const cached = cache[key];
  if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
    return cached.data;
  }
  return null;
}

function setCachedData(key: string, data: any) {
  cache[key] = { data, timestamp: Date.now() };
}

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());
  
  // Health Check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString(), cacheSize: Object.keys(cache).length });
  });

  // API Proxy for Financial Data (Yahoo Finance)
  app.get("/api/stock/:symbol", async (req, res) => {
    const { symbol } = req.params;
    const { range = '1d', interval = '1m' } = req.query;
    const cacheKey = `stock_${symbol}_${range}_${interval}`;

    const cached = getCachedData(cacheKey);
    if (cached) {
      console.log(`[API] Serving cached data for ${symbol}`);
      return res.json(cached);
    }

    console.log(`[API] Fetching data for ${symbol}`);
    
    // Ensure symbol has .NS or .BO suffix if not present
    let yahooSymbol = symbol.toUpperCase();
    
    // Mapping for common Indian indices
    const indexMapping: Record<string, string> = {
      'NIFTY 50': '^NSEI',
      'NIFTY50': '^NSEI',
      'NIFTY': '^NSEI',
      'SENSEX': '^BSESN',
      'NIFTY BANK': '^NSEBANK',
      'BANKNIFTY': '^NSEBANK',
      'NIFTY IT': '^CNXIT',
      'NIFTY AUTO': '^CNXAUTO',
      'NIFTY PHARMA': '^CNXPHARMA',
      'NIFTY METAL': '^CNXMETAL',
      'NIFTY FMCG': '^CNXFMCG',
      'NIFTY MEDIA': '^CNXMEDIA',
      'NIFTY ENERGY': '^CNXENERGY',
      'NIFTY INFRA': '^CNXINFRA',
      'NIFTY REALTY': '^CNXREALTY',
    };

    if (indexMapping[yahooSymbol]) {
      yahooSymbol = indexMapping[yahooSymbol];
    } else if (!yahooSymbol.startsWith("^") && !yahooSymbol.endsWith(".NS") && !yahooSymbol.endsWith(".BO")) {
      yahooSymbol = `${yahooSymbol}.NS`;
    }

    try {
      const encodedSymbol = encodeURIComponent(yahooSymbol);
      console.log(`[API] Requesting Yahoo Finance for ${yahooSymbol} (Range: ${range}, Interval: ${interval})`);
      
      const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodedSymbol}`, {
        params: { range, interval },
        timeout: 15000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept': 'application/json',
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache'
        }
      });

      if (!response.data || !response.data.chart) {
        console.error(`[API] Invalid response structure from Yahoo Finance for ${yahooSymbol}`);
        return res.status(502).json({ error: "Invalid response from data provider" });
      }

      const result = response.data.chart?.result?.[0];
      if (!result) {
        return res.status(404).json({ error: "Stock not found" });
      }

      const quote = result.indicators.quote[0];
      const timestamps = result.timestamp || [];
      
      const data = timestamps.map((t: number, i: number) => ({
        date: new Date(t * 1000).toISOString(),
        price: quote.close[i] || quote.open[i] || 0,
        volume: quote.volume[i] || 0
      })).filter((d: any) => d.price > 0);

      const meta = result.meta;
      
      const responseData = {
        symbol: yahooSymbol,
        price: meta.regularMarketPrice || (data.length > 0 ? data[data.length - 1].price : 0),
        currency: meta.currency,
        change: (meta.regularMarketPrice || 0) - (meta.previousClose || 0),
        changePercent: meta.previousClose ? (((meta.regularMarketPrice || 0) - meta.previousClose) / meta.previousClose) * 100 : 0,
        history: data
      };

      setCachedData(cacheKey, responseData);
      res.json(responseData);
    } catch (error: any) {
      if (error.response?.status === 404) {
        console.warn(`Stock ${yahooSymbol} not found on Yahoo Finance`);
        return res.status(404).json({ error: "Stock not found" });
      }
      console.error(`Error fetching stock ${yahooSymbol}:`, error.message);
      res.status(500).json({ error: "Failed to fetch stock data" });
    }
  });

  // Batch Quote Endpoint for Ticker
  app.get("/api/stocks/batch", async (req, res) => {
    const { symbols } = req.query;
    if (!symbols || typeof symbols !== 'string') {
      return res.status(400).json({ error: "Symbols are required" });
    }

    const cacheKey = `batch_${symbols}`;
    const cached = getCachedData(cacheKey);
    if (cached) {
      console.log(`[API] Serving cached batch quotes`);
      return res.json(cached);
    }

    const symbolList = symbols.split(',');
    // Limit to 10 symbols to ensure performance and avoid rate limits
    const limitedSymbols = symbolList.slice(0, 10);
    console.log(`[API] Fetching batch quotes for: ${limitedSymbols.join(', ')}`);

    try {
      const quotes = await Promise.all(limitedSymbols.map(async (symbol) => {
        try {
          // Using v8/finance/chart as it's more reliable than v7/finance/quote for bots
          // Ensure symbol is properly encoded for the URL
          const encodedSymbol = encodeURIComponent(symbol);
          const response = await axios.get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodedSymbol}`, {
            params: { range: '1d', interval: '1m' },
            timeout: 12000, // Increased timeout for batch
            headers: {
              'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
              'Accept': 'application/json',
              'Cache-Control': 'no-cache',
              'Pragma': 'no-cache'
            }
          });

          // Check if response is actually JSON
          if (typeof response.data !== 'object') {
            console.warn(`[API] Non-object response for ${symbol}`);
            return null;
          }

          const result = response.data.chart?.result?.[0];
          if (result) {
            const meta = result.meta;
            const price = meta.regularMarketPrice || 0;
            const prevClose = meta.previousClose || price;
            return {
              symbol: symbol,
              price: price,
              change: price - prevClose,
              changePercent: prevClose !== 0 ? ((price - prevClose) / prevClose) * 100 : 0,
              name: symbol.replace('.NS', '').replace('.BO', '').replace('^', '')
            };
          }
        } catch (e: any) {
          console.warn(`[API] Individual fetch failed for ${symbol}: ${e.message}`);
          return null;
        }
        return null;
      }));

      const validQuotes = quotes.filter(q => q !== null);
      if (validQuotes.length > 0) {
        setCachedData(cacheKey, validQuotes);
        return res.json(validQuotes);
      }

      res.status(502).json({ error: "Failed to fetch any quotes" });
    } catch (error: any) {
      console.error("[API] Fatal error in batch quotes:", error.message);
      res.status(500).json({ error: "Internal server error during quote fetch" });
    }
  });

  // Catch-all for API routes to prevent falling through to Vite SPA fallback
  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: `API route not found: ${req.method} ${req.url}` });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static("dist"));
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
