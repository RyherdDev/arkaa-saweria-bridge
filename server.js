
const express = require("express");
const crypto = require("crypto");
const Database = require("better-sqlite3");
const { createMiddleware } = require("saweria-webhook-express");

const app = express();
app.disable("x-powered-by");

const PORT = Number(process.env.PORT || 3000);
const STREAM_KEY = process.env.SAWERIA_STREAM_KEY;
const BRIDGE_SECRET = process.env.BRIDGE_SECRET;

if (!STREAM_KEY || !BRIDGE_SECRET || BRIDGE_SECRET.length < 32) {
    throw new Error("SAWERIA_STREAM_KEY dan BRIDGE_SECRET wajib diisi.");
}

const db = new Database(process.env.DB_PATH || "./saweria.sqlite");
db.pragma("journal_mode = WAL");

db.exec(`
    CREATE TABLE IF NOT EXISTS donations (
        id TEXT PRIMARY KEY,
        donor TEXT NOT NULL,
        amount INTEGER NOT NULL,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL,
        acknowledged INTEGER NOT NULL DEFAULT 0
    );
`);

app.use(express.json({ limit: "32kb" }));

const verifySaweria = createMiddleware(STREAM_KEY);

function requireBridgeSecret(req, res, next) {
    const supplied = req.get("x-bridge-secret") || "";
    const a = Buffer.from(supplied);
    const b = Buffer.from(BRIDGE_SECRET);

    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: "Unauthorized" });
    }

    next();
}

// Endpoint ini dipasang pada URL webhook di dashboard Saweria.
app.post("/saweria/webhook", verifySaweria, (req, res) => {
    try {
        const body = req.body;

        if (!body || body.type !== "donation") {
            return res.status(400).json({ error: "Unsupported event" });
        }

        const id = String(body.id || "");
        const donor = String(body.donator_name || "Anonim").slice(0, 60);
        const amount = Number(body.amount_raw);
        const message = String(body.message || "").slice(0, 200);
        const createdAt = String(body.created_at || new Date().toISOString());

        if (
            !/^[a-zA-Z0-9-]{8,100}$/.test(id) ||
            !Number.isSafeInteger(amount) ||
            amount <= 0
        ) {
            return res.status(400).json({ error: "Invalid donation data" });
        }

        // ID transaksi unik: callback berulang tidak menggandakan donasi.
        db.prepare(`
            INSERT OR IGNORE INTO donations
            (id, donor, amount, message, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(id, donor, amount, message, createdAt);

        return res.status(200).json({ ok: true });
    } catch (err) {
        console.error("Webhook processing failed:", err.message);
        return res.status(500).json({ error: "Internal error" });
    }
});

// Roblox mengambil antrean donasi yang belum di-acknowledge.
app.get("/roblox/poll", requireBridgeSecret, (req, res) => {
    const rows = db.prepare(`
        SELECT id, donor, amount, message, created_at
        FROM donations
        WHERE acknowledged = 0
        ORDER BY rowid ASC
        LIMIT 20
    `).all();

    res.set("Cache-Control", "no-store");
    res.json({ donations: rows });
});

// Roblox mengakui transaksi setelah pemrosesan berhasil.
app.post("/roblox/ack", requireBridgeSecret, (req, res) => {
    const ids = req.body && req.body.ids;

    if (
        !Array.isArray(ids) ||
        ids.length > 20 ||
        !ids.every(id => typeof id === "string" && id.length <= 100)
    ) {
        return res.status(400).json({ error: "Invalid IDs" });
    }

    const update = db.prepare(
        "UPDATE donations SET acknowledged = 1 WHERE id = ?"
    );

    const transaction = db.transaction(items => {
        for (const id of items) update.run(id);
    });

    transaction(ids);
    res.json({ ok: true });
});

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, "0.0.0.0", () => {
    console.log(`Saweria bridge listening on port ${PORT}`);
});
