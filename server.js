const express = require("express");
const axios   = require("axios");
const cheerio = require("cheerio");

const app  = express();
const PORT = process.env.PORT || 3000;

app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

app.get("/",       (req, res) => res.json({ service: "LiteFinance Copy Trading API", version: "3.3" }));
app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

// =============================================
// HELPER: fetch HTML
// =============================================
async function fetchText(url) {
    const r = await axios.get(url, {
        headers: {
            "User-Agent":      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
            "Accept":          "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
            "Accept-Language": "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
        },
        timeout: 12000
    });
    const $ = cheerio.load(r.data);
    return { $, text: $("body").text().replace(/\s+/g, " ").trim() };
}

// =============================================
// /info - Tài sản cá nhân của master
// Trang: /vi/traders/info?id=XXXXX
// Cấu trúc: "~14 000 USD TÀI SẢN CÁ NHÂN"
// =============================================
app.get("/info", async (req, res) => {
    try {
        const accountId = req.query.accountId;
        if (!accountId) return res.status(400).json({ success: false, error: "Missing accountId" });

        const { $, text } = await fetchText(
            `https://my.litefinance.com.vn/vi/traders/info?id=${accountId}`
        );

        // Tên trader
        const traderName = $("h1, h2").first().text().trim().replace(/^@/, "") || "";

        // Parse "~14 000 USD" hoặc "~14000 USD" → equity
        // Trang hiện: "~14 000 USD TÀI SẢN CÁ NHÂN"
        let equity = 0;
        const eqMatch = text.match(/~?([\d\s]+)\s*USD\s*TÀI SẢN CÁ NHÂN/i)
                     || text.match(/TÀI SẢN CÁ NHÂN[^~]*~?([\d\s]+)\s*USD/i)
                     || text.match(/~([\d\s,]+)\s*USD/);
        if (eqMatch) {
            equity = parseFloat(eqMatch[1].replace(/[\s,]/g, ""));
        }

        // Số nhà giao dịch sao chép
        let copyCount = 0;
        const ccMatch = text.match(/([\d]+)\s*SỐ NHÀ GIAO DỊCH SAO CHÉP/i)
                     || text.match(/SỐ NHÀ GIAO DỊCH SAO CHÉP[^\d]*([\d]+)/i);
        if (ccMatch) copyCount = parseInt(ccMatch[1]);

        console.log(`[INFO] ${traderName} equity=$${equity} copyCount=${copyCount}`);

        res.json({
            success: true,
            account: { id: accountId, name: traderName, equity, copyCount },
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        console.error("❌ /info:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// =============================================
// /trades - Danh sách lệnh đang mở
// KEY FIX: Dùng openTime+symbol+type làm stable ID
// thay vì ticket tăng dần → EA track được đúng lệnh
// =============================================
app.get("/trades", async (req, res) => {
    try {
        const accountId = req.query.accountId;
        if (!accountId) return res.status(400).json({ success: false, error: "Missing accountId" });

        const { $, text } = await fetchText(
            `https://my.litefinance.com.vn/vi/traders/trades?id=${accountId}`
        );

        const traderName = $("h2").text().trim().replace(/^@/, "");

        // =============================================
        // AUTO-DETECT SYMBOLS từ HTML - hỗ trợ mọi symbol
        // FIX: Nhận dạng cả hậu tố _m .m .r trong symbol
        // Ví dụ: ETHUSD_m → base=ETHUSD, BTCUSDm → BTCUSD
        // =============================================

        // Scan tìm symbol có thể có hậu tố: _m .r .m v.v
        // Pattern: [A-Z0-9] + tùy chọn [._][a-z0-9]{1,3}
        const symbolScanRe = /([A-Z0-9]{3,10}(?:[._][a-zA-Z0-9]{1,3})?)\s+(?:Mua|Bán)\s+\d+\.\d+\s+\d{2}\.\d{2}\.\d{4}/gi;
        const foundSymbols  = new Set();
        const symbolBaseMap = new Map(); // rawSymbol → baseName

        for (const sm of text.matchAll(symbolScanRe)) {
            const raw  = sm[1].toUpperCase();
            // Tách base: bỏ hậu tố _X hoặc .X (1-3 ký tự)
            const base = raw.replace(/[._][A-Z0-9]{1,3}$/, "");
            foundSymbols.add(raw);
            symbolBaseMap.set(raw, base);
        }
        console.log(`[SYMBOLS] Raw detected: ${[...foundSymbols].join(", ")}`);
        console.log(`[SYMBOLS] Base names:   ${[...symbolBaseMap.values()].filter((v,i,a)=>a.indexOf(v)===i).join(", ")}`);

        // Escape dấu _ và . để dùng trong regex
        const escRe = s => s.replace(/[._]/g, "\\$&");

        const symbolList = foundSymbols.size > 0
            ? [...foundSymbols].map(escRe).join("|")
            : "XAUUSD|XAGUSD|BTCUSD|ETHUSD|EURUSD|GBPUSD|USDJPY|AUDCAD|NZDCAD|USDCHF|USDCAD|EURGBP|EURJPY|GBPJPY|USTEC|GER40|US30|SPX500|NAS100|UK100|FRA40|JPN225";

        const rowPattern = new RegExp(
            `(${symbolList})\\s+(Mua|Bán)\\s+` +
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
        console.log(`[TRADES] Found ${matches.length} rows`);

        const positions = [];

        for (const m of matches) {
            // Base name: ETHUSD_m → ETHUSD, XAUUSD → XAUUSD
            const rawSym = m[1].toUpperCase();
            const symbol = (symbolBaseMap.get(rawSym) || rawSym.replace(/[._][A-Z0-9]{1,3}$/, "")).toUpperCase();
            const type         = /Bán/i.test(m[2]) ? 1 : 0;
            const volume       = parseFloat(m[3]);
            const dateParts    = m[4].split(".");           // DD MM YYYY
            const openTime     = `${dateParts[2]}-${dateParts[1]}-${dateParts[0]}T${m[5]}Z`;
            const openPrice    = parseFloat(m[6]);
            const currentPrice = parseFloat(m[7]);
            const slRaw        = parseFloat(m[8]);
            const tpRaw        = parseFloat(m[9]);

            // Validate SL/TP
            const sl = (slRaw > 0 && (
                (type === 0 && slRaw < openPrice) ||
                (type === 1 && slRaw > openPrice)
            )) ? slRaw : 0;

            const tp = (tpRaw > 0 && (
                (type === 0 && tpRaw > openPrice) ||
                (type === 1 && tpRaw < openPrice)
            )) ? tpRaw : 0;

            // =============================================
            // STABLE TICKET: dùng hash từ symbol+type+openTime+openPrice
            // Đảm bảo cùng 1 lệnh luôn có cùng ticket qua các lần gọi API
            // =============================================
            const stableKey = `${symbol}_${type}_${openTime}_${openPrice}`;
            const ticket     = stableHash(stableKey);

            console.log(`  [OK] ${symbol} ${type===0?'BUY':'SELL'} vol=${volume} open=${openPrice} ticket=${ticket}`);

            positions.push({ ticket, symbol, type, volume, openPrice, currentPrice, sl, tp, openTime });
        }

        res.json({
            success: true,
            account: { id: accountId, name: traderName },
            positions,
            positionsCount: positions.length,
            timestamp: new Date().toISOString()
        });

    } catch (err) {
        console.error("❌ /trades:", err.message);
        res.status(500).json({ success: false, error: err.message });
    }
});

// =============================================
// STABLE HASH: tạo số nguyên dương từ string
// Luôn trả về cùng số cho cùng input
// =============================================
function stableHash(str) {
    let hash = 5381;
    for (let i = 0; i < str.length; i++) {
        hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
        hash = hash >>> 0; // convert to unsigned 32-bit
    }
    // Đảm bảo trong range hợp lý (100000 - 9999999)
    return 100000 + (hash % 9900000);
}

// Debug endpoint - xem raw text
app.get("/debug", async (req, res) => {
    try {
        const accountId = req.query.accountId || "1550403";
        const page      = req.query.page || "trades";
        const { text }  = await fetchText(
            `https://my.litefinance.com.vn/vi/traders/${page}?id=${accountId}`
        );
        res.json({ sample: text.substring(0, 3000), length: text.length });
    } catch(err) {
        res.json({ error: err.message });
    }
});

const server = app.listen(PORT, () => console.log(`LiteFinance API v3.3 running on port ${PORT}`));
process.on('SIGTERM', () => server.close());