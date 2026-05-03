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
    res.json({ service: "LiteFinance Copy Trading API", version: "2.1", endpoints: { trades: "/trades?accountId=1550403" } });
});

app.get("/trades", async (req, res) => {
    try {
        const accountId = req.query.accountId;
        if (!accountId) return res.status(400).json({ success: false, error: "Missing accountId parameter" });

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

        const $ = cheerio.load(response.data);
        const traderName = $("h2").text().trim().replace("@", "");
        let text = $("body").text().replace(/\s+/g, " ").trim();
        console.log(`Text length: ${text.length} chars`);

        const SYMBOLS = ["XAUUSD", "XAGUSD", "BTCUSD", "ETHUSD", "EURUSD", "GBPUSD", "USDJPY", "AUDCAD", "NZDCAD"];

        // FIX: Parse theo từng action "Mua/Bán LOT" thay vì theo symbol
        // Mỗi lệnh chỉ có đúng 1 dòng Mua/Bán -> tránh duplicate
        const actionRegex = /(Mua|Bán)\s+(\d+\.\d+)/gi;
        const actionMatches = [...text.matchAll(actionRegex)];

        let positions = [];
        let ticket = 100000;

        for (const actionMatch of actionMatches) {
            const actionIndex = actionMatch.index;
            const actionType = actionMatch[1];
            const volume = parseFloat(actionMatch[2]);

            const blockBefore = text.substring(Math.max(0, actionIndex - 200), actionIndex);
            const blockAfter = text.substring(actionIndex, actionIndex + 300);

            // Tìm symbol gần nhất trước action
            let symbol = null;
            let symbolPos = -1;
            for (const sym of SYMBOLS) {
                const pos = blockBefore.lastIndexOf(sym);
                if (pos > symbolPos) { symbolPos = pos; symbol = sym; }
            }
            if (!symbol) { console.log(`⚠️ No symbol at index ${actionIndex}`); continue; }

            const type = /Bán/i.test(actionType) ? 1 : 0;

            const allNumbers = [...blockAfter.matchAll(/\d+[\.,]\d+/g)]
                .map(x => parseFloat(x[0].replace(",", ".")));

            const prices = allNumbers.filter(n => {
                if (Math.abs(n - volume) < 0.0001) return false;
                if (n < 50) return false;
                if (n >= 2020 && n <= 2030) return false;
                return true;
            });

            console.log(`[${symbol}] ${actionType} ${volume} prices:`, prices);
            if (prices.length === 0) { console.log("⚠️ No prices, skip"); continue; }

            const openPrice = prices[0];
            const currentPrice = prices.length > 1 ? prices[1] : openPrice;
            let sl = 0, tp = 0;

            if (prices.length >= 3) {
                const p3 = prices[2];
                if (type === 0) { if (p3 < openPrice) sl = p3; else tp = p3; }
                else { if (p3 > openPrice) sl = p3; else tp = p3; }
            }
            if (prices.length >= 4) {
                const p4 = prices[3];
                if (sl === 0 && type === 0 && p4 < openPrice) sl = p4;
                else if (tp === 0 && type === 0 && p4 > openPrice) tp = p4;
                else if (sl === 0 && type === 1 && p4 > openPrice) sl = p4;
                else if (tp === 0 && type === 1 && p4 < openPrice) tp = p4;
            }

            const dateMatch = blockAfter.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
            let openTime = new Date().toISOString();
            if (dateMatch) {
                const [_, day, month, year, hour, minute, second] = dateMatch;
                openTime = `${year}-${month}-${day}T${hour}:${minute}:${second}Z`;
            }

            positions.push({ ticket: ticket++, symbol: symbol.replace("_m","").toUpperCase(), type, volume, openPrice, currentPrice, sl, tp, openTime });
        }

        // Deduplicate: cùng symbol+type+volume+openPrice chỉ giữ 1
        const seen = new Set();
        positions = positions.filter(p => {
            const key = `${p.symbol}_${p.type}_${p.volume}_${p.openPrice}`;
            if (seen.has(key)) { console.log(`⚠️ Dedup: ${key}`); return false; }
            seen.add(key); return true;
        });

        console.log(`📊 Total positions: ${positions.length}`);

        res.json({
            success: true,
            account: { id: accountId, name: traderName, equity: 0, investors: 0, maxDrawdown: 0 },
            positions,
            positionsCount: positions.length,
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.error("❌ Error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get("/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
});

const server = app.listen(PORT, () => {
    console.log(`LiteFinance Copy Trading API v2.1 running on port ${PORT}`);
});

process.on('SIGTERM', () => { server.close(() => console.log('HTTP server closed')); });