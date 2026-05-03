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
    res.json({ service: "LiteFinance Copy Trading API", version: "2.2", endpoints: { trades: "/trades?accountId=1550403" } });
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

        // =============================================
        // PARSE THEO CỘT HTML TABLE - CHÍNH XÁC NHẤT
        // Các cột: SYMBOL | KIỂU | KHỐI LƯỢNG | NGÀY | VÀO LỆNH | HIỆN TẠI | DỪNG LỖ | CHỐT LỜI | LỢI NHUẬN
        // =============================================

        const SYMBOLS = ["XAUUSD","XAGUSD","BTCUSD","ETHUSD","EURUSD","GBPUSD","USDJPY","AUDCAD","NZDCAD"];
        let positions = [];
        let ticket = 100000;

        // Thử parse từng row của table
        $("tr, [class*='row'], [class*='trade'], [class*='position']").each((i, row) => {
            const cells = [];
            $(row).find("td, [class*='cell'], [class*='col']").each((j, cell) => {
                cells.push($(cell).text().trim().replace(/\s+/g, " "));
            });

            if (cells.length < 6) return; // Bỏ qua row không đủ cột

            const rowText = cells.join(" | ");

            // Tìm symbol trong row
            let symbol = null;
            for (const sym of SYMBOLS) {
                if (rowText.includes(sym)) { symbol = sym; break; }
            }
            if (!symbol) return;

            // Xác định BUY/SELL
            const isBuy  = /MUA|BUY/i.test(rowText);
            const isSell = /BÁN|SELL/i.test(rowText);
            if (!isBuy && !isSell) return;
            const type = isSell ? 1 : 0;

            console.log(`\nROW [${symbol}]:`, cells);

            // Lấy tất cả số trong row
            const nums = [];
            for (const cell of cells) {
                const n = parseFloat(cell.replace(",", "."));
                if (!isNaN(n) && n > 0) nums.push({ val: n, raw: cell });
            }

            // Layout cột chuẩn của LiteFinance:
            // [icon/symbol] [kiểu] [volume] [datetime] [openPrice] [currentPrice] [sl] [tp] [profit USD]
            // Tìm volume: số nhỏ (0.01 - 100)
            const volumeNum = nums.find(n => n.val >= 0.01 && n.val <= 100);
            if (!volumeNum) return;
            const volume = volumeNum.val;

            // Tìm prices: số lớn hơn volume, bỏ số trông như năm
            const priceNums = nums.filter(n => {
                if (Math.abs(n.val - volume) < 0.001) return false;
                if (n.val < 50) return false;
                if (n.val >= 2020 && n.val <= 2030) return false; // năm
                return true;
            });

            console.log("Price candidates:", priceNums.map(n => n.val));

            if (priceNums.length < 1) return;

            // Thứ tự cột: openPrice, currentPrice, sl, tp, profit
            // Profit là số CUỐI cùng → bỏ đi
            const priceValues = priceNums.map(n => n.val);

            // Bỏ số cuối (lợi nhuận USD) nếu có >= 5 số
            let usefulPrices = priceValues.length >= 4
                ? priceValues.slice(0, priceValues.length - 1) // bỏ profit
                : priceValues;

            const openPrice    = usefulPrices[0] || 0;
            const currentPrice = usefulPrices[1] || openPrice;
            const sl           = usefulPrices[2] || 0;
            const tp           = usefulPrices[3] || 0;

            // Validate SL/TP theo logic BUY/SELL
            const validSl = sl > 0 && (
                (type === 0 && sl < openPrice) ||  // BUY: SL < entry
                (type === 1 && sl > openPrice)     // SELL: SL > entry
            ) ? sl : 0;

            const validTp = tp > 0 && (
                (type === 0 && tp > openPrice) ||  // BUY: TP > entry
                (type === 1 && tp < openPrice)     // SELL: TP < entry
            ) ? tp : 0;

            // Parse datetime
            let openTime = new Date().toISOString();
            const dateMatch = rowText.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
            if (dateMatch) {
                const [_, day, month, year, hour, min, sec] = dateMatch;
                openTime = `${year}-${month}-${day}T${hour}:${min}:${sec}Z`;
            }

            const position = {
                ticket: ticket++,
                symbol,
                type,
                volume,
                openPrice,
                currentPrice,
                sl: validSl,
                tp: validTp,
                openTime
            };

            positions.push(position);
            console.log("✅", position);
        });

        // Nếu parse table không ra → fallback parse text như cũ nhưng bỏ số cuối (profit)
        if (positions.length === 0) {
            console.log("Table parse failed, fallback to text parse...");
            let text = $("body").text().replace(/\s+/g, " ").trim();
            const actionRegex = /(Mua|Bán)\s+(\d+\.\d+)/gi;
            const actionMatches = [...text.matchAll(actionRegex)];

            for (const actionMatch of actionMatches) {
                const actionIndex = actionMatch.index;
                const volume = parseFloat(actionMatch[2]);
                const blockBefore = text.substring(Math.max(0, actionIndex - 200), actionIndex);
                const blockAfter  = text.substring(actionIndex, actionIndex + 400);

                let symbol = null, symbolPos = -1;
                for (const sym of SYMBOLS) {
                    const pos = blockBefore.lastIndexOf(sym);
                    if (pos > symbolPos) { symbolPos = pos; symbol = sym; }
                }
                if (!symbol) continue;

                const type = /Bán/i.test(actionMatch[1]) ? 1 : 0;

                const allNums = [...blockAfter.matchAll(/[\d]+\.[\d]+/g)].map(x => parseFloat(x[0]));
                let prices = allNums.filter(n => {
                    if (Math.abs(n - volume) < 0.001) return false;
                    if (n < 50) return false;
                    if (n >= 2020 && n <= 2030) return false;
                    return true;
                });

                // Bỏ số cuối (profit)
                if (prices.length > 3) prices = prices.slice(0, prices.length - 1);

                if (prices.length === 0) continue;

                const openPrice    = prices[0];
                const currentPrice = prices[1] || openPrice;
                let sl = prices[2] || 0;
                let tp = prices[3] || 0;

                // Validate
                if (sl > 0 && !((type===0 && sl<openPrice)||(type===1 && sl>openPrice))) sl = 0;
                if (tp > 0 && !((type===0 && tp>openPrice)||(type===1 && tp<openPrice))) tp = 0;

                const dateMatch = blockAfter.match(/(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
                let openTime = new Date().toISOString();
                if (dateMatch) {
                    const [_, day, month, year, hour, min, sec] = dateMatch;
                    openTime = `${year}-${month}-${day}T${hour}:${min}:${sec}Z`;
                }

                positions.push({ ticket: ticket++, symbol, type, volume, openPrice, currentPrice, sl, tp, openTime });
            }

            // Deduplicate
            const seen = new Set();
            positions = positions.filter(p => {
                const key = `${p.symbol}_${p.type}_${p.volume}_${p.openPrice}`;
                if (seen.has(key)) return false;
                seen.add(key); return true;
            });
        }

        console.log(`📊 Total: ${positions.length} positions`);

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

app.get("/health", (req, res) => res.json({ status: "ok", timestamp: new Date().toISOString() }));

const server = app.listen(PORT, () => console.log(`LiteFinance API v2.2 running on port ${PORT}`));
process.on('SIGTERM', () => server.close());
