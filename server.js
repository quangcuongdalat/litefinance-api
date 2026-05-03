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
    res.json({ service: "LiteFinance Copy Trading API", version: "2.3" });
});

// Debug endpoint - xem raw text để phân tích
app.get("/debug", async (req, res) => {
    try {
        const accountId = req.query.accountId || "1550403";
        const url = `https://my.litefinance.com.vn/vi/traders/trades?id=${accountId}`;
        const response = await axios.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                "Accept-Language": "vi-VN,vi;q=0.9"
            },
            timeout: 10000
        });
        const $ = cheerio.load(response.data);
        
        // Trả về text từng dòng để debug
        let text = $("body").text().replace(/\s+/g, " ").trim();
        
        // Tìm đoạn chứa positions
        const idx = text.indexOf("XAUUSD");
        const sample = text.substring(Math.max(0, idx - 100), idx + 2000);
        
        res.json({ 
            sample,
            fullLength: text.length,
            // Tìm tất cả Mua/Bán
            actions: [...text.matchAll(/(Mua|Bán)\s+[\d.]+/gi)].map(m => ({
                match: m[0],
                index: m.index,
                context: text.substring(Math.max(0,m.index-50), m.index+50)
            }))
        });
    } catch(err) {
        res.json({ error: err.message });
    }
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
        let text = $("body").text().replace(/\s+/g, " ").trim();

        const SYMBOLS = ["XAUUSD","XAGUSD","BTCUSD","ETHUSD","EURUSD","GBPUSD","USDJPY","AUDCAD","NZDCAD"];
        let positions = [];
        let ticket = 100000;

        // Parse theo từng action Mua/Bán
        const actionRegex = /(Mua|Bán)\s+(\d+\.\d+)/gi;
        const actionMatches = [...text.matchAll(actionRegex)];

        console.log(`Found ${actionMatches.length} actions`);

        for (const actionMatch of actionMatches) {
            const actionIndex = actionMatch.index;
            const volume = parseFloat(actionMatch[2]);
            const isSell = /Bán/i.test(actionMatch[1]);
            const type = isSell ? 1 : 0;

            // Lấy block trước để tìm symbol
            const blockBefore = text.substring(Math.max(0, actionIndex - 300), actionIndex);
            // Lấy block sau để tìm giá (không quá dài để tránh lấy lệnh kế tiếp)
            const blockAfter = text.substring(actionIndex, actionIndex + 250);

            // Tìm symbol gần nhất TRƯỚC action
            let symbol = null, symbolPos = -1;
            for (const sym of SYMBOLS) {
                const pos = blockBefore.lastIndexOf(sym);
                if (pos > symbolPos) { symbolPos = pos; symbol = sym; }
            }
            if (!symbol) { console.log(`No symbol at ${actionIndex}`); continue; }

            // Tìm datetime (bắt buộc phải có để xác định đây là lệnh thật)
            const dateMatch = blockAfter.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
            if (!dateMatch) {
                // Thử tìm ngày ở blockBefore
                const dateBefore = blockBefore.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/g);
                if (!dateBefore) {
                    console.log(`No datetime near action at ${actionIndex}, skip`);
                    continue; // Không có datetime → không phải row lệnh thật
                }
            }

            let openTime = new Date().toISOString();
            const dm = (blockBefore + blockAfter).match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
            if (dm) {
                const [_, day, month, year, hour, min, sec] = dm;
                openTime = `${year}-${month}-${day}T${hour}:${min}:${sec}Z`;
            }

            // Lấy số trong blockAfter
            // Layout: [action+vol] [datetime] [openPrice] [currentPrice] [sl] [tp] [profit]
            // Bỏ: volume, số < 50, năm 2020-2030
            const allNums = [...blockAfter.matchAll(/\b(\d+\.?\d*)\b/g)]
                .map(x => parseFloat(x[0]))
                .filter(n => {
                    if (Math.abs(n - volume) < 0.001) return false; // bỏ volume
                    if (n < 50) return false;                         // bỏ số nhỏ
                    if (n >= 2020 && n <= 2030) return false;         // bỏ năm
                    if (n >= 1 && n <= 31 && Number.isInteger(n)) return false; // bỏ ngày
                    return true;
                });

            console.log(`[${symbol}] ${isSell?'SELL':'BUY'} ${volume} | nums:`, allNums);

            if (allNums.length === 0) continue;

            const openPrice    = allNums[0] || 0;
            const currentPrice = allNums[1] || openPrice;

            // allNums[2] = SL, allNums[3] = TP, allNums[4] = profit (bỏ)
            let sl = allNums[2] || 0;
            let tp = allNums[3] || 0;

            // Validate SL/TP theo hướng lệnh
            if (sl > 0) {
                const slValid = (type === 0 && sl < openPrice) || (type === 1 && sl > openPrice);
                if (!slValid) sl = 0;
            }
            if (tp > 0) {
                const tpValid = (type === 0 && tp > openPrice) || (type === 1 && tp < openPrice);
                if (!tpValid) tp = 0;
            }

            positions.push({ ticket: ticket++, symbol, type, volume, openPrice, currentPrice, sl, tp, openTime });
        }

        // Deduplicate chặt: cùng symbol+type+volume+openPrice+openTime → bỏ duplicate
        const seen = new Set();
        positions = positions.filter(p => {
            const key = `${p.symbol}_${p.type}_${p.volume}_${p.openPrice}_${p.openTime}`;
            if (seen.has(key)) { console.log(`Dedup: ${key}`); return false; }
            seen.add(key);
            return true;
        });

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

const server = app.listen(PORT, () => console.log(`LiteFinance API v2.3 running on port ${PORT}`));
process.on('SIGTERM', () => server.close());
