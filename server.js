const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");

const app = express();
const PORT = process.env.PORT || 3000;

// ======================================================
// CORS
// ======================================================
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header(
        "Access-Control-Allow-Headers",
        "Origin, X-Requested-With, Content-Type, Accept"
    );
    next();
});

// ======================================================
// ROOT
// ======================================================
app.get("/", (req, res) => {
    res.json({
        service: "LiteFinance Copy Trading API",
        version: "4.0"
    });
});

app.get("/health", (req, res) => {
    res.json({
        status: "ok",
        timestamp: new Date().toISOString()
    });
});

// ======================================================
// HELPER
// ======================================================
function cleanNumber(str) {
    if (!str) return 0;

    return parseFloat(
        str
            .replace(/~/g, "")
            .replace(/\s/g, "")
            .replace(/,/g, "")
            .trim()
    ) || 0;
}

function getPageText($) {
    return $("body")
        .text()
        .replace(/\s+/g, " ")
        .trim();
}

// ======================================================
// /info
// Lấy thông tin tài khoản master
// https://litefinance-api.onrender.com/info?accountId=1550403
// ======================================================
app.get("/info", async (req, res) => {
    try {
        const accountId = req.query.accountId;

        if (!accountId) {
            return res.status(400).json({
                success: false,
                error: "Missing accountId"
            });
        }

        const url = `https://my.litefinance.com.vn/vi/traders/info?id=${accountId}`;

        console.log(`\n========================================`);
        console.log(`[INFO] Fetching: ${url}`);

        const response = await axios.get(url, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                "Accept":
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language":
                    "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7",
                "Cache-Control": "no-cache",
                "Pragma": "no-cache"
            },
            timeout: 15000
        });

        const $ = cheerio.load(response.data);
        const text = getPageText($);

        // ======================================================
        // Parse trader name
        // ======================================================
        let traderName = "";

        $("h1, h2, h3").each((i, el) => {
            const t = $(el).text().trim();

            if (t.includes("@")) {
                traderName = t.replace("@", "").trim();
            }
        });

        // fallback
        if (!traderName) {
            const nameMatch = text.match(/@([A-Za-z0-9_\-]+)/);
            if (nameMatch) {
                traderName = nameMatch[1];
            }
        }

        // ======================================================
        // Parse tài sản cá nhân
        // ======================================================
        let equity = 0;

        const equityMatch = text.match(
            /~?\s*([\d\s,.]+)\s*USD\s*TÀI SẢN CÁ NHÂN/i
        );

        if (equityMatch) {
            equity = cleanNumber(equityMatch[1]);
        }

        // ======================================================
        // Parse tài sản copy trader
        // ======================================================
        let copyAssets = 0;

        const copyAssetsMatch = text.match(
            /~?\s*([\d\s,.]+)\s*USD\s*TÀI SẢN CỦA NHÀ GIAO DỊCH SAO CHÉP/i
        );

        if (copyAssetsMatch) {
            copyAssets = cleanNumber(copyAssetsMatch[1]);
        }

        // ======================================================
        // Parse risk
        // ======================================================
        let risk = 0;

        const riskMatch = text.match(/RỦI RO\s*(\d+)/i);

        if (riskMatch) {
            risk = parseInt(riskMatch[1]) || 0;
        }

        // ======================================================
        // Parse số copier
        // ======================================================
        let copiers = 0;

        const copierMatch = text.match(
            /(\d+)\s*SỐ NHÀ GIAO DỊCH SAO CHÉP/i
        );

        if (copierMatch) {
            copiers = parseInt(copierMatch[1]) || 0;
        }

        // ======================================================
        // Parse số ngày
        // ======================================================
        let rankingDays = 0;

        const dayMatch = text.match(
            /(\d+)\s*ngày\s*TRONG BẢNG XẾP HẠNG/i
        );

        if (dayMatch) {
            rankingDays = parseInt(dayMatch[1]) || 0;
        }

        // ======================================================
        // Parse gain %
        // ======================================================
        let gainPercent = 0;

        const gainMatch = text.match(
            /(?:Lợi nhuận|Gain|Profit)\s*([+-]?[\d.,]+)\s*%/i
        );

        if (gainMatch) {
            gainPercent = parseFloat(
                gainMatch[1].replace(",", ".")
            ) || 0;
        }

        // ======================================================
        // Parse drawdown
        // ======================================================
        let drawdown = 0;

        const ddMatch = text.match(
            /(?:Drawdown|Sụt giảm)\s*([\d.,]+)\s*%/i
        );

        if (ddMatch) {
            drawdown = parseFloat(
                ddMatch[1].replace(",", ".")
            ) || 0;
        }

        // ======================================================
        // Debug
        // ======================================================
        console.log(`[INFO] Trader Name : ${traderName}`);
        console.log(`[INFO] Equity      : ${equity}`);
        console.log(`[INFO] CopyAssets  : ${copyAssets}`);
        console.log(`[INFO] Risk        : ${risk}`);
        console.log(`[INFO] Copiers     : ${copiers}`);

        // ======================================================
        // Response
        // ======================================================
        res.json({
            success: true,

            account: {
                id: accountId,
                name: traderName,

                equity,
                copyAssets,

                risk,
                copiers,

                rankingDays,

                gainPercent,
                drawdown
            },

            timestamp: new Date().toISOString()
        });

    } catch (err) {

        console.error("❌ /info error:", err.message);

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ======================================================
// /trades
// Lấy danh sách lệnh đang mở
// ======================================================
app.get("/trades", async (req, res) => {

    try {

        const accountId = req.query.accountId;

        if (!accountId) {
            return res.status(400).json({
                success: false,
                error: "Missing accountId"
            });
        }

        const url =
            `https://my.litefinance.com.vn/vi/traders/trades?id=${accountId}`;

        console.log(`\n========================================`);
        console.log(`[TRADES] Fetching: ${url}`);

        const response = await axios.get(url, {
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
                "Accept":
                    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                "Accept-Language":
                    "vi-VN,vi;q=0.9,en-US;q=0.8,en;q=0.7"
            },
            timeout: 15000
        });

        const $ = cheerio.load(response.data);

        const text = getPageText($);

        // ======================================================
        // Parse trader name
        // ======================================================
        let traderName = "";

        $("h1, h2, h3").each((i, el) => {

            const t = $(el).text().trim();

            if (t.includes("@")) {
                traderName = t.replace("@", "").trim();
            }
        });

        // ======================================================
        // Parse positions
        // ======================================================
        const SYMBOLS =
            "XAUUSD|XAGUSD|BTCUSD|ETHUSD|EURUSD|GBPUSD|USDJPY|AUDCAD|NZDCAD|US30|USTEC|NAS100";

        const rowPattern = new RegExp(
            `(${SYMBOLS})\\s+` +
            `(Mua|Bán)\\s+` +
            `(\\d+\\.\\d+)\\s+` +
            `(\\d{2}\\.\\d{2}\\.\\d{4})\\s+` +
            `(\\d{2}:\\d{2}:\\d{2})\\s+` +
            `([\\d.]+)\\s+` +
            `([\\d.]+)\\s+` +
            `([\\d.]+)\\s+` +
            `([\\d.]+)\\s+` +
            `Lợi nhuận\\s+-?[\\d.,]+\\s+USD`,
            "gi"
        );

        const matches = [...text.matchAll(rowPattern)];

        console.log(`[TRADES] Found ${matches.length} positions`);

        let positions = [];
        let ticket = 100000;

        for (const m of matches) {

            const symbol =
                m[1]
                    .replace("_m", "")
                    .toUpperCase();

            const type =
                /Bán/i.test(m[2]) ? 1 : 0;

            const volume =
                parseFloat(m[3]);

            const [day, month, year] =
                m[4].split(".");

            const openTime =
                `${year}-${month}-${day}T${m[5]}Z`;

            const openPrice =
                parseFloat(m[6]);

            const currentPrice =
                parseFloat(m[7]);

            const slRaw =
                parseFloat(m[8]);

            const tpRaw =
                parseFloat(m[9]);

            const sl =
                slRaw > 0 &&
                (
                    (type === 0 && slRaw < openPrice) ||
                    (type === 1 && slRaw > openPrice)
                )
                    ? slRaw
                    : 0;

            const tp =
                tpRaw > 0 &&
                (
                    (type === 0 && tpRaw > openPrice) ||
                    (type === 1 && tpRaw < openPrice)
                )
                    ? tpRaw
                    : 0;

            positions.push({
                ticket: ticket++,

                symbol,
                type,

                volume,

                openPrice,
                currentPrice,

                sl,
                tp,

                openTime
            });
        }

        // ======================================================
        // Response
        // ======================================================
        res.json({
            success: true,

            account: {
                id: accountId,
                name: traderName
            },

            positions,
            positionsCount: positions.length,

            timestamp: new Date().toISOString()
        });

    } catch (err) {

        console.error("❌ /trades error:", err.message);

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ======================================================
// DEBUG
// ======================================================
app.get("/debug", async (req, res) => {

    try {

        const accountId =
            req.query.accountId || "1550403";

        const page =
            req.query.page || "info";

        const url =
            `https://my.litefinance.com.vn/vi/traders/${page}?id=${accountId}`;

        const response = await axios.get(url, {
            headers: {
                "User-Agent": "Mozilla/5.0",
                "Accept-Language": "vi-VN,vi;q=0.9"
            },
            timeout: 15000
        });

        const $ = cheerio.load(response.data);

        const text =
            $("body")
                .text()
                .replace(/\s+/g, " ")
                .trim();

        res.json({
            success: true,

            url,

            length: text.length,

            sample: text.substring(0, 5000)
        });

    } catch (err) {

        res.status(500).json({
            success: false,
            error: err.message
        });
    }
});

// ======================================================
// START SERVER
// ======================================================
const server = app.listen(PORT, () => {

    console.log(`========================================`);
    console.log(`LiteFinance API v4.0 running`);
    console.log(`PORT: ${PORT}`);
    console.log(`========================================`);
});

process.on("SIGTERM", () => {
    server.close();
});