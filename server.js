const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for MT5 to access
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

// Root endpoint
app.get("/", (req, res) => {
    res.json({
        service: "LiteFinance Copy Trading API",
        version: "2.0",
        endpoints: {
            trades: "/trades?accountId=1550403"
        }
    });
});

// Main endpoint - Get trader positions
app.get("/trades", async (req, res) => {
    try {
        const accountId = req.query.accountId;

        if (!accountId) {
            return res.status(400).json({
                success: false,
                error: "Missing accountId parameter",
                usage: "/trades?accountId=1550403"
            });
        }

        const url = `https://my.litefinance.com.vn/vi/traders/trades?id=${accountId}`;
        
        console.log(`[${new Date().toISOString()}] Fetching: ${url}`);

        const response = await axios.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
            },
            timeout: 10000
        });

        const html = response.data;
        const $ = cheerio.load(html);

        // Extract trader name
        const traderName = $("h2").text().trim().replace("@", "");

        // Get clean text
        let text = $("body").text();
        text = text.replace(/\s+/g, " ").trim();

        console.log(`Text length: ${text.length} chars`);

        // =====================================
        // PARSE POSITIONS USING REGEX
        // =====================================
        
        const regex = /(XAUUSD|XAGUSD|BTCUSD(?:_m)?|ETHUSD(?:_m)?|EURUSD|GBPUSD|USDJPY|AUDCAD|NZDCAD)[\s\S]{0,300}?(Mua|Bán)/gi;
        const matches = [...text.matchAll(regex)];

        let positions = [];
        let ticket = 100000;

        for (const match of matches) {
            const start = match.index;
            const block = text.substring(start, start + 350);

            console.log("\n--- PARSING BLOCK ---");
            console.log(block.substring(0, 200) + "...");

            // Extract symbol
            const symbolMatch = block.match(/(XAUUSD|XAGUSD|BTCUSD(?:_m)?|ETHUSD(?:_m)?|EURUSD|GBPUSD|USDJPY|AUDCAD|NZDCAD)/i);
            if (!symbolMatch) continue;

            const symbol = symbolMatch[1].replace("_m", "").toUpperCase();

            // Extract type (BUY/SELL)
            let type = 0; // BUY
            if (/Bán/i.test(block)) {
                type = 1; // SELL
            }

            // Extract lot size
            const lotMatch = block.match(/(Mua|Bán)\s+(\d+\.\d+)/i);
            if (!lotMatch) {
                console.log("⚠️ No lot found, skipping");
                continue;
            }

            const volume = parseFloat(lotMatch[2]);

            // Extract all numbers
            const allNumbers = [...block.matchAll(/\d+\.\d+/g)].map(x => parseFloat(x[0]));
            console.log("All numbers:", allNumbers);

            // Filter valid prices
            let prices = allNumbers.filter(n => {
                if (n === volume) return false;
                if (n < 50) return false;
                return true;
            });

            console.log("Valid prices:", prices);

            if (prices.length === 0) {
                console.log("⚠️ No valid prices found, skipping");
                continue;
            }

            const openPrice = prices[0];
            const currentPrice = prices.length > 1 ? prices[1] : openPrice;

            let sl = 0;
            let tp = 0;

            if (prices.length >= 3) {
                const p3 = prices[2];
                if (type === 0) {
                    if (p3 < openPrice) sl = p3;
                    else tp = p3;
                } else {
                    if (p3 > openPrice) sl = p3;
                    else tp = p3;
                }
            }

            if (prices.length >= 4) {
                const p4 = prices[3];
                if (sl === 0 && type === 0 && p4 < openPrice) sl = p4;
                else if (tp === 0 && type === 0 && p4 > openPrice) tp = p4;
                else if (sl === 0 && type === 1 && p4 > openPrice) sl = p4;
                else if (tp === 0 && type === 1 && p4 < openPrice) tp = p4;
            }

            const dateMatch = block.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
            let openTime = new Date().toISOString();
            if (dateMatch) {
                const [_, day, month, year, hour, minute, second] = dateMatch;
                openTime = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
            }

            const position = {
                ticket: ticket++,
                symbol: symbol,
                type: type,
                volume: volume,
                openPrice: openPrice,
                currentPrice: currentPrice,
                sl: sl,
                tp: tp,
                openTime: openTime
            };

            positions.push(position);
            console.log("✅ Parsed position:", position);
        }

        console.log(`\n📊 Total positions found: ${positions.length}`);

        const result = {
            success: true,
            account: {
                id: accountId,
                name: traderName,
                equity: 0,
                investors: 0,
                maxDrawdown: 0
            },
            positions: positions,
            positionsCount: positions.length,
            timestamp: new Date().toISOString()
        };

        res.json(result);

    } catch (err) {
        console.error("❌ Error:", err.message);
        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// Health check endpoint
app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

// Start server
const server = app.listen(PORT, () => {
    console.log(`LiteFinance Copy Trading API v2.0 running on port ${PORT}`);
});

process.on('SIGTERM', () => {
    server.close(() => console.log('HTTP server closed'));
});
