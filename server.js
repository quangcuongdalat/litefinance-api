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
    res.json({ service: "LiteFinance Copy Trading API", version: "3.0" });
});

app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

// =============================================
// /info - Lấy thông tin tài khoản master
// https://my.litefinance.com.vn/vi/traders/info?id=XXXXX
// =============================================
app.get("/info", async (req, res) => {
    try {
        const accountId = req.query.accountId;
        if (!accountId) return res.status(400).json({ success: false, error: "Missing accountId" });

        const url = `https://my.litefinance.com.vn/vi/traders/info?id=${accountId}`;
        console.log(`[INFO] Fetching: ${url}`);

        const response = await axios.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
            },
            timeout: 10000
        });

        const $ = cheerio.load(response.data);
        const text = $("body").text().replace(/\s+/g, " ").trim();

        // Parse tên trader
        const traderName = $("h1, h2").first().text().trim().replace("@", "") || "";

        // Parse equity/balance từ trang info
        // Tìm các pattern số tiền: "$X,XXX.XX" hoặc "X XXX.XX USD"
        let equity = 0;

        // Thử tìm "Vốn" hoặc "Equity" trực tiếp trong text
        const equityPatterns = [
            /(?:Vốn|Equity|Balance|Số dư)[:\s]*\$?([\d\s,]+\.?\d*)/i,
            /\$\s*([\d,]+\.?\d*)/,
            /([\d,]+\.?\d*)\s*USD/
        ];

        for (const pat of equityPatterns) {
            const m = text.match(pat);
            if (m) {
                const val = parseFloat(m[1].replace(/[\s,]/g, ""));
                if (val > 100) { equity = val; break; }
            }
        }

        // Parse các số liệu thống kê khác
        let gainPercent = 0, drawdown = 0, investors = 0, trades = 0;

        const gainM = text.match(/(?:Lợi nhuận|Gain|Profit)[:\s%]*([+-]?[\d.]+)\s*%/i);
        if (gainM) gainPercent = parseFloat(gainM[1]);

        const ddM = text.match(/(?:Drawdown|Sụt giảm)[:\s%]*([\d.]+)\s*%/i);
        if (ddM) drawdown = parseFloat(ddM[1]);

        const invM = text.match(/(?:Nhà đầu tư|Investors?)[:\s]*([\d,]+)/i);
        if (invM) investors = parseInt(invM[1].replace(/,/g, ""));

        const trM = text.match(/(?:Lệnh|Trades?)[:\s]*([\d,]+)/i);
        if (trM) trades = parseInt(trM[1].replace(/,/g, ""));

        // Debug: trả về sample text để kiểm tra
        const debugIdx = Math.max(0, text.indexOf("$"));
        const sample = text.substring(debugIdx, debugIdx + 500);

        console.log(`[INFO] Trader: ${traderName}, Equity: ${equity}`);

        res.json({
            success: true,
            account: {
                id: accountId,
                name: traderName,
                equity,
                gainPercent,
                drawdown,
                investors,
                trades
            },
            debug: { sample },
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.error("❌ /info error:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// =============================================
// /trades - Lấy danh sách lệnh đang mở
// =============================================
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

        const SYMBOLS = "XAUUSD|XAGUSD|BTCUSD|ETHUSD|EURUSD|GBPUSD|USDJPY|AUDCAD|NZDCAD";

        const rowPattern = new RegExp(
            `(${SYMBOLS})\\s+(Mua|Bán)\\s+` +
            `(\\d+\\.\\d+)\\s+` +
            `(\\d{2}\\.\\d{2}\\.\\d{4})\\s+` +
            `(\\d{2}:\\d{2}:\\d{2})\\s+` +
            `([\\d.]+)\\s+` +
            `([\\d.]+)\\s+` +
            `([\\d.]+)\\s+` +
            `([\\d.]+)\\s+` +
            `Lợi nhuận\\s+-?[\\d.,]+\\s+USD`,
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

            const sl = slRaw > 0 && (
                (type === 0 && slRaw < openPrice) ||
                (type === 1 && slRaw > openPrice)
            ) ? slRaw : 0;

            const tp = tpRaw > 0 && (
                (type === 0 && tpRaw > openPrice) ||
                (type === 1 && tpRaw < openPrice)
            ) ? tpRaw : 0;

            positions.push({ ticket: ticket++, symbol, type, volume, openPrice, currentPrice, sl, tp, openTime });
        }

        console.log(`📊 Total: ${positions.length}`);

        res.json({
            success: true,
            account: { id: accountId, name: traderName },
            positions,
            positionsCount: positions.length,
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.error("❌", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// Debug endpoint
app.get("/debug", async (req, res) => {
    try {
        const accountId = req.query.accountId || "1550403";
        const page = req.query.page || "trades";
        const url = `https://my.litefinance.com.vn/vi/traders/${page}?id=${accountId}`;
        const response = await axios.get(url, {
            headers: { "User-Agent": "Mozilla/5.0", "Accept-Language": "vi-VN,vi;q=0.9" },
            timeout: 10000
        });
        const $ = cheerio.load(response.data);
        let text = $("body").text().replace(/\s+/g, " ").trim();
        res.json({ sample: text.substring(0, 3000), length: text.length });
    } catch(err) {
        res.json({ error: err.message });
    }
});

const server = app.listen(PORT, () => console.log(`LiteFinance API v3.0 running on port ${PORT}`));
process.on('SIGTERM', () => server.close());