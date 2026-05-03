const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

app.get("/", (req, res) => {
    res.json({ service: "LiteFinance Copy Trading API", version: "2.5" });
});

app.get("/debug", async (req, res) => {
    const accountId = req.query.accountId || "1550403";
    const url = `https://my.litefinance.com.vn/vi/traders/trades?id=${accountId}`;
    const response = await axios.get(url, {
        headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "vi-VN,vi;q=0.9" },
        timeout: 10000
    });
    const $ = cheerio.load(response.data);
    let text = $("body").text().replace(/\s+/g, " ").trim();
    const idx = text.indexOf("XAUUSD");
    res.json({ sample: text.substring(Math.max(0, idx-50), idx+2000) });
});

app.get("/trades", async (req, res) => {
    try {
        const accountId = req.query.accountId;
        if (!accountId) return res.status(400).json({ success: false, error: "Missing accountId" });

        const url = `https://my.litefinance.com.vn/vi/traders/trades?id=${accountId}`;
        console.log(`Fetching: ${url}`);

        const response = await axios.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
            },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);
        const traderName = $("h2").text().trim().replace("@", "");
        const text = $("body").text().replace(/\s+/g, " ").trim();

        // =============================================
        // Cấu trúc 1 row lệnh:
        // SYMBOL (Mua|Bán) VOLUME DD.MM.YYYY HH:MM:SS OPEN CURRENT SL TP Lợi nhuận -?NUMBER USD
        // FIX v2.5: profit có thể âm (-79.62) → thêm -? vào pattern
        // =============================================

        const SYMBOLS = "XAUUSD|XAGUSD|BTCUSD|ETHUSD|EURUSD|GBPUSD|USDJPY|AUDCAD|NZDCAD";

        const rowPattern = new RegExp(
            `(${SYMBOLS})\\s+(Mua|Bán)\\s+` +       // symbol + type
            `(\\d+\\.\\d+)\\s+` +                     // volume
            `(\\d{2}\\.\\d{2}\\.\\d{4})\\s+` +        // date DD.MM.YYYY
            `(\\d{2}:\\d{2}:\\d{2})\\s+` +            // time HH:MM:SS
            `([\\d.]+)\\s+` +                          // openPrice
            `([\\d.]+)\\s+` +                          // currentPrice
            `([\\d.]+)\\s+` +                          // sl
            `([\\d.]+)\\s+` +                          // tp
            `Lợi nhuận\\s+-?[\\d.,]+\\s+USD`,         // profit (bỏ, có thể âm)
            'gi'
        );

        const matches = [...text.matchAll(rowPattern)];
        console.log(`Found ${matches.length} rows`);

        let positions = [];
        let ticket = 100000;

        for (const m of matches) {
            const symbol       = m[1].replace("_m","").toUpperCase();
            const type         = /Bán/i.test(m[2]) ? 1 : 0;
            const volume       = parseFloat(m[3]);
            const [day, month, year] = m[4].split(".");
            const openTime     = `${year}-${month}-${day}T${m[5]}Z`;
            const openPrice    = parseFloat(m[6]);
            const currentPrice = parseFloat(m[7]);
            const slRaw        = parseFloat(m[8]);
            const tpRaw        = parseFloat(m[9]);

            // Validate SL/TP theo hướng lệnh
            const sl = slRaw > 0 && (
                (type === 0 && slRaw < openPrice) ||  // BUY: SL < entry
                (type === 1 && slRaw > openPrice)     // SELL: SL > entry
            ) ? slRaw : 0;

            const tp = tpRaw > 0 && (
                (type === 0 && tpRaw > openPrice) ||  // BUY: TP > entry
                (type === 1 && tpRaw < openPrice)     // SELL: TP < entry
            ) ? tpRaw : 0;

            const position = { ticket: ticket++, symbol, type, volume, openPrice, currentPrice, sl, tp, openTime };
            console.log("✅", JSON.stringify(position));
            positions.push(position);
        }

        console.log(`📊 Total: ${positions.length}`);

        res.json({
            success: true,
            account: { id: accountId, name: traderName, equity: 0, investors: 0, maxDrawdown: 0 },
            positions,
            positionsCount: positions.length,
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.error("❌", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

const server = app.listen(PORT, () => console.log(`LiteFinance API v2.5 running on port ${PORT}`));
process.on('SIGTERM', () => server.close());
