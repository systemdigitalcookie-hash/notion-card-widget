const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg"); // PostgreSQL Client

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// --- CONFIGURATION ---
const NOTION_TOKEN = process.env.NOTION_TOKEN;
const NOTION_VERSION = "2025-09-03"; 
const DEFAULT_PROPERTY = "WidgetValue"; 

// --- DATABASE CONNECTION (RAILWAY) ---
// Railway provides a DATABASE_URL env variable automatically
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false } // Required for Railway
});

// --- HELPER: INITIALIZE TABLE ---
// Runs once on startup to ensure the table exists
async function initDB() {
  const query = `
    CREATE TABLE IF NOT EXISTS widgets (
      id TEXT PRIMARY KEY,
      title TEXT,
      icon TEXT,
      prefix TEXT,
      subtext TEXT,
      db_id TEXT,
      property TEXT,
      manual_value TEXT
    );
  `;
  try {
    await pool.query(query);
    console.log("✅ Database table check passed.");
  } catch (err) {
    console.error("❌ DB Init Error:", err);
  }
}
initDB();

// --- DB HELPER FUNCTIONS ---
async function getWidgets() {
  try {
    const result = await pool.query("SELECT * FROM widgets");
    return result.rows; // Postgres returns data in .rows
  } catch (e) {
    console.error(e);
    return [];
  }
}

async function getWidgetById(id) {
  try {
    const result = await pool.query("SELECT * FROM widgets WHERE id = $1", [id]);
    return result.rows[0];
  } catch (e) {
    return null;
  }
}

// --- NOTION API LOGIC (Unchanged) ---
async function getNotionSum(databaseId, propertyName) {
  try {
    if (!NOTION_TOKEN) return 0;
    const targetProp = propertyName || DEFAULT_PROPERTY;

    const headers = {
      Authorization: `Bearer ${NOTION_TOKEN}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    };

    let dataSources = [];
    try {
      const dbResponse = await axios.get(
        `https://api.notion.com/v1/databases/${databaseId}`,
        { headers }
      );
      if (dbResponse.data.data_sources) dataSources = dbResponse.data.data_sources;
      else dataSources = [{ id: databaseId }];
    } catch (e) {
      console.error("Meta Error:", e.response?.data || e.message);
      return null;
    }

    let totalSum = 0;
    for (const source of dataSources) {
      try {
        const queryUrl = `https://api.notion.com/v1/data_sources/${source.id}/query`;
        const response = await axios.post(queryUrl, { page_size: 100 }, { headers });

        for (const page of response.data.results) {
          const prop = page.properties[targetProp];
          if (!prop) continue; 
          if (prop.type === "formula" && prop.formula.type === "number") {
            totalSum += prop.formula.number || 0;
          } else if (prop.type === "number") {
            totalSum += prop.number || 0;
          }
        }
      } catch (innerError) {
        console.error(`Source Error (${source.id}):`, innerError.message);
      }
    }
    return totalSum; 
  } catch (error) {
    console.error("Critical Error:", error.message);
    return null;
  }
}

// --- FRONTEND: DASHBOARD ---
app.get("/", async (req, res) => {
  const widgets = await getWidgets(); // Now async
  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const baseUrl = `${protocol}://${req.headers.host}`;

  const rows = widgets.map(w => {
    const embedUrl = `${baseUrl}/embed/${w.id}`;
    const sourceInfo = w.db_id 
      ? `<span style="color:green; font-weight:bold;">Live:</span> ${w.property || DEFAULT_PROPERTY}` 
      : `<span style="color:#666;">Manual</span>`;
    
    return `
      <tr style="border-bottom: 1px solid #ddd;">
        <td style="padding:15px;">
           <div style="font-weight:bold;">${w.title}</div>
           <div style="font-size:12px; color:#666;">${sourceInfo}</div>
        </td>
        <td style="padding:15px; font-family:monospace; font-size:12px;">
            ${w.db_id || w.manual_value}
        </td>
        <td style="padding:15px;">
           <input type="text" value="${embedUrl}" style="width:100%; padding:5px; font-size:11px; background:#f0f0f0; border:1px solid #ccc;" readonly onclick="this.select()">
        </td>
        <td style="padding:15px; display:flex; gap:10px;">
          <a href="/edit/${w.id}" style="text-decoration:none; color:#007bff; font-weight:bold; border:1px solid #007bff; padding:4px 8px; border-radius:4px; font-size:12px;">✏️ Edit</a>
          <form action="/delete" method="POST" style="margin:0;">
            <input type="hidden" name="id" value="${w.id}">
            <button type="submit" style="color:red; background:none; border:none; cursor:pointer; font-size:16px;">✖</button>
          </form>
        </td>
      </tr>
    `;
  }).join("");

  res.send(`
    <body style="font-family: sans-serif; padding: 40px; max-width: 900px; margin: 0 auto; background: #f9f9f9;">
      <div style="background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.05);">
        <h2>📊 Notion Widget Hub (Railway Edition)</h2>
        <hr style="border:0; border-top:1px solid #eee; margin: 20px 0;">
        <div style="background:#f4f4f4; padding:20px; border-radius:8px; border:1px dashed #ccc; margin-bottom:30px;">
          <h3 style="margin-top:0;">➕ Add Widget</h3>
          <form action="/add" method="POST">
            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px;">
              <div><label style="font-size:11px; font-weight:bold; color:#555;">TITLE</label><br><input type="text" name="title" placeholder="Net Profit" style="width:95%; padding:8px;" required></div>
              <div><label style="font-size:11px; font-weight:bold; color:#555;">ICON</label><br><input type="text" name="icon" placeholder="trending-up" style="width:95%; padding:8px;" required></div>
              <div><label style="font-size:11px; font-weight:bold; color:#555;">PREFIX</label><br><input type="text" name="prefix" placeholder="$" style="width:95%; padding:8px;"></div>
              <div style="grid-column: span 3;"><label style="font-size:11px; font-weight:bold; color:#555;">SUBTEXT</label><br><input type="text" name="subtext" placeholder="Q3 Performance" style="width:98%; padding:8px;" required></div>
              <div style="grid-column: span 3; background: white; padding: 15px; border: 1px solid #ddd; border-radius: 4px; margin-top:5px;">
                <strong style="display:block; margin-bottom:10px;">Data Source</strong>
                <div style="display:flex; gap:20px; align-items:flex-start;">
                  <div style="flex:2;">
                    <label style="font-size:11px; font-weight:bold; color:#007bff;">OPTION A: Live Sum</label><br>
                    <div style="display:flex; gap:10px;">
                        <input type="text" name="dbId" placeholder="Database ID" style="flex:2; padding:8px;">
                        <input type="text" name="property" placeholder="Property Name" style="flex:1; padding:8px; border:1px solid #007bff; background:#eef6ff;">
                    </div>
                  </div>
                  <div style="flex:1;">
                    <label style="font-size:11px; font-weight:bold; color:#28a745;">OPTION B: Manual</label><br>
                    <input type="text" name="manualValue" placeholder="1000" style="width:100%; padding:8px;">
                  </div>
                </div>
              </div>
            </div>
            <button type="submit" style="margin-top:15px; background:#333; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer;">Create Widget</button>
          </form>
        </div>
        <table style="width:100%; border-collapse: collapse; text-align:left;">
          <thead><tr style="background:#f1f1f1;"><th style="padding:10px;">Widget</th><th style="padding:10px;">Source</th><th style="padding:10px;">Embed URL</th><th style="padding:10px;">Actions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </body>
  `);
});

// --- ROUTE: EDIT PAGE ---
app.get("/edit/:id", async (req, res) => {
  const w = await getWidgetById(req.params.id);
  if (!w) return res.send("Widget not found.");

  res.send(`
    <body style="font-family: sans-serif; padding: 40px; max-width: 700px; margin: 0 auto; background: #f9f9f9;">
      <div style="background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.05);">
        <h2>✏️ Edit Widget</h2>
        <form action="/update" method="POST">
          <input type="hidden" name="id" value="${w.id}">
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 15px;">
            <div><label style="font-size:11px; font-weight:bold; color:#555;">TITLE</label><br><input type="text" name="title" value="${w.title}" style="width:95%; padding:8px;" required></div>
            <div><label style="font-size:11px; font-weight:bold; color:#555;">ICON</label><br><input type="text" name="icon" value="${w.icon}" style="width:95%; padding:8px;" required></div>
            <div><label style="font-size:11px; font-weight:bold; color:#555;">PREFIX</label><br><input type="text" name="prefix" value="${w.prefix || ''}" style="width:95%; padding:8px;"></div>
            <div><label style="font-size:11px; font-weight:bold; color:#555;">SUBTEXT</label><br><input type="text" name="subtext" value="${w.subtext}" style="width:95%; padding:8px;" required></div>
          </div>
          <div style="margin-top:20px; background: #fdfdfd; padding: 15px; border: 1px solid #ddd; border-radius: 4px;">
            <div style="display:flex; gap:10px; margin-bottom:15px;">
               <input type="text" name="dbId" value="${w.db_id || ''}" placeholder="Database ID" style="flex:2; padding:8px;">
               <input type="text" name="property" value="${w.property || ''}" placeholder="Property Name" style="flex:1; padding:8px; border:1px solid #007bff; background:#eef6ff;">
            </div>
            <input type="text" name="manualValue" value="${w.manual_value || ''}" placeholder="Manual Value" style="width:100%; padding:8px;">
          </div>
          <div style="margin-top:20px; display:flex; justify-content:space-between;">
             <a href="/" style="text-decoration:none; color:#666; padding:10px;">Cancel</a>
             <button type="submit" style="background:#007bff; color:white; padding:10px 25px; border:none; border-radius:4px; cursor:pointer;">Save Changes</button>
          </div>
        </form>
      </div>
    </body>
  `);
});

// --- API ROUTES (SQL VERSION) ---
app.post("/add", async (req, res) => {
  const { title, icon, prefix, subtext, dbId, property, manualValue } = req.body;
  const id = uuidv4();
  
  await pool.query(
    `INSERT INTO widgets (id, title, icon, prefix, subtext, db_id, property, manual_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [id, title, icon, prefix, subtext, dbId || null, property || null, manualValue || "0"]
  );
  
  res.redirect("/");
});

app.post("/update", async (req, res) => {
  const { id, title, icon, prefix, subtext, dbId, property, manualValue } = req.body;
  
  await pool.query(
    `UPDATE widgets SET title=$1, icon=$2, prefix=$3, subtext=$4, db_id=$5, property=$6, manual_value=$7 WHERE id=$8`,
    [title, icon, prefix, subtext, dbId || null, property || null, manualValue || "0", id]
  );
  
  res.redirect("/");
});

app.post("/delete", async (req, res) => {
  await pool.query("DELETE FROM widgets WHERE id = $1", [req.body.id]);
  res.redirect("/");
});

// --- EMBED RENDERER ---
app.get("/embed/:id", async (req, res) => {
  const widget = await getWidgetById(req.params.id);
  if (!widget) return res.send("Widget not found");

  let finalNumber = widget.manual_value;
  if (widget.db_id) {
    const sum = await getNotionSum(widget.db_id, widget.property);
    if (sum !== null) finalNumber = sum;
  }

  let displayString = finalNumber;
  if (!isNaN(finalNumber)) {
     const num = parseFloat(finalNumber);
     displayString = num.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
     if (displayString.endsWith(".00")) displayString = displayString.slice(0, -3); 
  }

  const fullDisplay = `${widget.prefix || ''}${displayString}`;

  res.send(`
    <html>
      <head>
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <meta http-equiv="refresh" content="300"> 
        <script src="https://unpkg.com/feather-icons"></script>
        <style>
          :root { --card-bg: #FFFFFF; --card-border: #E0E0E0; --text-title: #787774; --text-value: #37352F; --text-sub: #9B9A97; --icon-color: #9B9A97; }
          @media (prefers-color-scheme: dark) { :root { --card-bg: #202020; --card-border: #333333; --text-title: #AFAFAF; --text-value: #FFFFFF; --text-sub: #808080; --icon-color: #808080; } }
          body { margin: 0; padding: 10px; overflow: hidden; background-color: transparent; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif; }
          .card { background-color: var(--card-bg); border: 1px solid var(--card-border); border-radius: 8px; height: calc(100vh - 20px); padding: 20px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; }
          .header-row { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 12px; }
          .title { font-size: 13px; font-weight: 600; color: var(--text-title); text-transform: uppercase; letter-spacing: 0.5px; }
          .value { font-size: 38px; font-weight: 700; color: var(--text-value); margin-bottom: 6px; letter-spacing: -0.5px; line-height: 1; }
          .subtext { font-size: 13px; color: var(--text-sub); }
          .icon-box { color: var(--icon-color); }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="header-row">
            <div class="title">${widget.title}</div>
            <div class="icon-box"><i data-feather="${widget.icon}" width="18" height="18"></i></div>
          </div>
          <div class="value">${fullDisplay}</div>
          <div class="subtext">${widget.subtext}</div>
        </div>
        <script>feather.replace();</script>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));