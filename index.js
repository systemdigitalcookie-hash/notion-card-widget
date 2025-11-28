const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");
const cookieSession = require("cookie-session");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// --- SESSION SETUP (Cookies) ---
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET || 'secret_key_123'], // Simple encryption key
  maxAge: 24 * 60 * 60 * 1000 // 24 hours
}));

// --- CONFIGURATION ---
const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID;
const NOTION_CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET;
const NOTION_REDIRECT_URI = process.env.NOTION_REDIRECT_URI; // e.g. https://.../auth/notion/callback
const NOTION_VERSION = "2025-09-03"; 
const DEFAULT_PROPERTY = "WidgetValue"; 

// --- DATABASE CONNECTION ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- INIT DB (UPDATED FOR USERS) ---
async function initDB() {
  try {
    // 1. Create USERS Table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        access_token TEXT,
        workspace_name TEXT,
        bot_id TEXT
      );
    `);
    
    // 2. Create WIDGETS Table (With user_id link)
    await pool.query(`
      CREATE TABLE IF NOT EXISTS widgets (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        title TEXT,
        icon TEXT,
        prefix TEXT,
        subtext TEXT,
        db_id TEXT,
        property TEXT,
        manual_value TEXT
      );
    `);
    console.log("✅ Database tables ready.");
  } catch (err) {
    console.error("❌ DB Init Error:", err);
  }
}
initDB();

// --- AUTH MIDDLEWARE ---
// Forces user to login if they try to access Dashboard
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

// --- NOTION API: DYNAMIC TOKEN ---
// Now takes 'accessToken' instead of using env var
async function getNotionSum(accessToken, databaseId, propertyName) {
  try {
    if (!accessToken) return 0;
    const targetProp = propertyName || DEFAULT_PROPERTY;

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    };

    // 1. Get Data Sources
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
        // console.error(`Source Error:`, innerError.message);
      }
    }
    return totalSum; 
  } catch (error) {
    console.error("Critical Error:", error.message);
    return null;
  }
}

// --- ROUTES: AUTHENTICATION ---

// 1. Login Page (Landing)
app.get('/login', (req, res) => {
  res.send(`
    <body style="font-family:sans-serif; display:flex; justify-content:center; align-items:center; height:100vh; background:#f9f9f9;">
      <div style="text-align:center; background:white; padding:40px; border-radius:8px; box-shadow:0 4px 20px rgba(0,0,0,0.1);">
        <h1>📊 Notion Widget Hub</h1>
        <p>Connect your Notion workspace to start creating widgets.</p>
        <a href="/auth/notion" style="background:black; color:white; padding:12px 24px; text-decoration:none; border-radius:4px; font-weight:bold;">Continue with Notion</a>
      </div>
    </body>
  `);
});

// 2. Redirect to Notion
app.get('/auth/notion', (req, res) => {
  const notionAuthUrl = `https://api.notion.com/v1/oauth/authorize?client_id=${NOTION_CLIENT_ID}&response_type=code&owner=user&redirect_uri=${encodeURIComponent(NOTION_REDIRECT_URI)}`;
  res.redirect(notionAuthUrl);
});

// 3. Callback (Notion sends user back here)
app.get('/auth/notion/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Error: No code received from Notion");

  try {
    // Exchange Code for Token
    const authString = Buffer.from(`${NOTION_CLIENT_ID}:${NOTION_CLIENT_SECRET}`).toString('base64');
    const response = await axios.post('https://api.notion.com/v1/oauth/token', {
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: NOTION_REDIRECT_URI
    }, {
      headers: {
        'Authorization': `Basic ${authString}`,
        'Content-Type': 'application/json'
      }
    });

    const { access_token, bot_id, owner, workspace_name } = response.data;
    const userId = owner.user.id; // Unique Notion User ID

    // Save/Update User in DB
    await pool.query(`
      INSERT INTO users (id, access_token, workspace_name, bot_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE 
      SET access_token = $2, workspace_name = $3;
    `, [userId, access_token, workspace_name || "My Workspace", bot_id]);

    // Set Session
    req.session.userId = userId;
    
    res.redirect('/');
  } catch (error) {
    console.error(error.response?.data || error.message);
    res.send("Error logging in with Notion.");
  }
});

// 4. Logout
app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});


// --- ROUTES: DASHBOARD (PROTECTED) ---
app.get("/", requireAuth, async (req, res) => {
  const userId = req.session.userId;
  
  // Fetch widgets ONLY for this user
  const result = await pool.query("SELECT * FROM widgets WHERE user_id = $1", [userId]);
  const widgets = result.rows;

  const protocol = req.headers['x-forwarded-proto'] || req.protocol;
  const baseUrl = `${protocol}://${req.headers.host}`;

  const rows = widgets.map(w => {
    const embedUrl = `${baseUrl}/embed/${w.id}`;
    return `
      <tr style="border-bottom: 1px solid #ddd;">
        <td style="padding:15px;">
           <div style="font-weight:bold;">${w.title}</div>
           <div style="font-size:12px; color:#666;">${w.db_id ? "Live Data" : "Manual"}</div>
        </td>
        <td style="padding:15px;">
           <input type="text" value="${embedUrl}" style="width:100%; padding:5px; font-size:11px; background:#f0f0f0;" readonly onclick="this.select()">
        </td>
        <td style="padding:15px;">
          <a href="/edit/${w.id}" style="text-decoration:none; color:#007bff; margin-right:10px;">Edit</a>
          <form action="/delete" method="POST" style="display:inline;">
            <input type="hidden" name="id" value="${w.id}">
            <button type="submit" style="color:red; background:none; border:none; cursor:pointer;">✖</button>
          </form>
        </td>
      </tr>
    `;
  }).join("");

  res.send(`
    <body style="font-family: sans-serif; padding: 40px; max-width: 900px; margin: 0 auto; background: #f9f9f9;">
      <div style="background: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 10px rgba(0,0,0,0.05);">
        <div style="display:flex; justify-content:space-between; align-items:center;">
           <h2>📊 Notion Widget Hub</h2>
           <a href="/logout" style="font-size:12px; color:red;">Logout</a>
        </div>
        <hr style="border:0; border-top:1px solid #eee; margin: 20px 0;">

        <div style="background:#f4f4f4; padding:20px; border-radius:8px; border:1px dashed #ccc; margin-bottom:30px;">
          <h3 style="margin-top:0;">➕ Add Widget</h3>
          <form action="/add" method="POST">
            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap: 15px;">
              <div><label style="font-size:11px; font-weight:bold;">TITLE</label><br><input type="text" name="title" placeholder="Net Profit" style="width:95%; padding:8px;" required></div>
              <div><label style="font-size:11px; font-weight:bold;">ICON</label><br><input type="text" name="icon" placeholder="trending-up" style="width:95%; padding:8px;" required></div>
              <div><label style="font-size:11px; font-weight:bold;">PREFIX</label><br><input type="text" name="prefix" placeholder="$" style="width:95%; padding:8px;"></div>
              <div style="grid-column: span 3;"><label style="font-size:11px; font-weight:bold;">SUBTEXT</label><br><input type="text" name="subtext" placeholder="Q3 Performance" style="width:98%; padding:8px;" required></div>
              
              <div style="grid-column: span 3; background: white; padding: 15px; border: 1px solid #ddd; border-radius: 4px; margin-top:5px;">
                 <label style="font-size:11px; font-weight:bold; color:#007bff;">OPTION A: Notion Data</label><br>
                 <div style="display:flex; gap:10px; margin-bottom:10px;">
                    <input type="text" name="dbId" placeholder="Database ID" style="flex:2; padding:8px;">
                    <input type="text" name="property" placeholder="Property Name" style="flex:1; padding:8px;">
                 </div>
                 <label style="font-size:11px; font-weight:bold; color:#28a745;">OPTION B: Manual</label><br>
                 <input type="text" name="manualValue" placeholder="0" style="width:100%; padding:8px;">
              </div>
            </div>
            <button type="submit" style="margin-top:15px; background:#333; color:white; padding:10px 20px; border:none; border-radius:4px; cursor:pointer;">Create Widget</button>
          </form>
        </div>

        <table style="width:100%; border-collapse: collapse; text-align:left;">
          <thead><tr style="background:#f1f1f1;"><th style="padding:10px;">Widget</th><th style="padding:10px;">Embed URL</th><th style="padding:10px;">Actions</th></tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    </body>
  `);
});

// --- ROUTES: EDIT (PROTECTED) ---
app.get("/edit/:id", requireAuth, async (req, res) => {
  const result = await pool.query("SELECT * FROM widgets WHERE id = $1 AND user_id = $2", [req.params.id, req.session.userId]);
  const w = result.rows[0];
  if (!w) return res.send("Widget not found or access denied.");

  res.send(`
    <body style="font-family: sans-serif; padding: 40px; max-width: 700px; margin: 0 auto; background: #f9f9f9;">
      <div style="background: white; padding: 30px; border-radius: 8px;">
        <h2>✏️ Edit Widget</h2>
        <form action="/update" method="POST">
          <input type="hidden" name="id" value="${w.id}">
          <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 15px;">
            <div><label style="font-size:11px; font-weight:bold;">TITLE</label><br><input type="text" name="title" value="${w.title}" style="width:95%; padding:8px;" required></div>
            <div><label style="font-size:11px; font-weight:bold;">ICON</label><br><input type="text" name="icon" value="${w.icon}" style="width:95%; padding:8px;" required></div>
            <div><label style="font-size:11px; font-weight:bold;">PREFIX</label><br><input type="text" name="prefix" value="${w.prefix||''}" style="width:95%; padding:8px;"></div>
            <div><label style="font-size:11px; font-weight:bold;">SUBTEXT</label><br><input type="text" name="subtext" value="${w.subtext}" style="width:95%; padding:8px;" required></div>
          </div>
          <br>
          <div style="background:#f4f4f4; padding:15px;">
             <input type="text" name="dbId" value="${w.db_id||''}" placeholder="DB ID" style="width:60%; padding:8px;">
             <input type="text" name="property" value="${w.property||''}" placeholder="Property" style="width:30%; padding:8px;">
             <br><br>
             <input type="text" name="manualValue" value="${w.manual_value||''}" placeholder="Manual Value" style="width:100%; padding:8px;">
          </div>
          <br>
          <button type="submit" style="background:#007bff; color:white; padding:10px 25px; border:none; cursor:pointer;">Save</button>
        </form>
      </div>
    </body>
  `);
});

// --- API ACTIONS (PROTECTED) ---
app.post("/add", requireAuth, async (req, res) => {
  const { title, icon, prefix, subtext, dbId, property, manualValue } = req.body;
  const id = uuidv4();
  await pool.query(
    `INSERT INTO widgets (id, user_id, title, icon, prefix, subtext, db_id, property, manual_value)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [id, req.session.userId, title, icon, prefix, subtext, dbId || null, property || null, manualValue || "0"]
  );
  res.redirect("/");
});

app.post("/update", requireAuth, async (req, res) => {
  const { id, title, icon, prefix, subtext, dbId, property, manualValue } = req.body;
  await pool.query(
    `UPDATE widgets SET title=$1, icon=$2, prefix=$3, subtext=$4, db_id=$5, property=$6, manual_value=$7 
     WHERE id=$8 AND user_id=$9`,
    [title, icon, prefix, subtext, dbId || null, property || null, manualValue || "0", id, req.session.userId]
  );
  res.redirect("/");
});

app.post("/delete", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM widgets WHERE id = $1 AND user_id = $2", [req.body.id, req.session.userId]);
  res.redirect("/");
});


// --- PUBLIC EMBED ROUTE (NO AUTH REQUIRED) ---
// This is the "Magic" part. The viewer doesn't need to login.
// The code uses the Widget ID to find the User, then uses THAT User's token.
app.get("/embed/:id", async (req, res) => {
  // 1. Get Widget
  const wRes = await pool.query("SELECT * FROM widgets WHERE id = $1", [req.params.id]);
  const widget = wRes.rows[0];

  if (!widget) return res.send("Widget not found");

  // 2. Get the Owner's Token
  const uRes = await pool.query("SELECT access_token FROM users WHERE id = $1", [widget.user_id]);
  const user = uRes.rows[0];

  if (!user) return res.send("Owner not found");

  // 3. Fetch Data using Owner's Token
  let finalNumber = widget.manual_value;
  if (widget.db_id) {
    const sum = await getNotionSum(user.access_token, widget.db_id, widget.property);
    if (sum !== null) finalNumber = sum;
  }

  // 4. Render
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