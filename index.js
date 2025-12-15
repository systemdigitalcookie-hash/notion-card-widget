const express = require("express");
const bodyParser = require("body-parser");
const axios = require("axios");
const { v4: uuidv4 } = require("uuid");
const { Pool } = require("pg");
const cookieSession = require("cookie-session");

const app = express();
app.use(bodyParser.urlencoded({ extended: true }));

// --- SESSION SETUP ---
app.use(cookieSession({
  name: 'session',
  keys: [process.env.SESSION_SECRET || 'secret_key_123'],
  maxAge: 24 * 60 * 60 * 1000 // 24 hours
}));

// --- CONFIGURATION ---
const NOTION_CLIENT_ID = process.env.NOTION_CLIENT_ID;
const NOTION_CLIENT_SECRET = process.env.NOTION_CLIENT_SECRET;
const NOTION_REDIRECT_URI = process.env.NOTION_REDIRECT_URI;
const NOTION_VERSION = "2022-06-28"; 
const DEFAULT_PROPERTY = "WidgetValue"; 

// --- DATABASE CONNECTION ---
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// --- INIT DB ---
async function initDB() {
  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        access_token TEXT,
        workspace_name TEXT,
        bot_id TEXT
      );
    `);
    await pool.query(`
      CREATE TABLE IF NOT EXISTS widgets (
        id TEXT PRIMARY KEY,
        user_id TEXT,
        title TEXT,
        prefix TEXT,
        subtext TEXT,
        db_id TEXT,
        property TEXT,
        calculation TEXT 
      );
    `);
    console.log("✅ Database tables ready.");
  } catch (err) {
    console.error("❌ DB Init Error:", err);
  }
}
initDB();

// --- MIDDLEWARE ---
function requireAuth(req, res, next) {
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }
  next();
}

// --- NOTION API: AGGREGATOR ---
async function getNotionAggregatedValue(accessToken, databaseId, propertyName, calculationType) {
  try {
    if (!accessToken) return 0;
    const targetProp = propertyName || DEFAULT_PROPERTY;
    const calc = calculationType || "sum"; 

    const headers = {
      Authorization: `Bearer ${accessToken}`,
      "Notion-Version": NOTION_VERSION,
      "Content-Type": "application/json",
    };

    let values = [];
    
    try {
      const queryUrl = `https://api.notion.com/v1/databases/${databaseId}/query`;
      const response = await axios.post(queryUrl, { page_size: 100 }, { headers });

      for (const page of response.data.results) {
        if (!page.properties || !page.properties[targetProp]) continue;

        const prop = page.properties[targetProp];
        let num = null;

        if (prop.type === "formula" && prop.formula.type === "number") {
          num = prop.formula.number;
        } else if (prop.type === "number") {
          num = prop.number;
        } else if (prop.type === "rollup" && prop.rollup.type === "number") {
          num = prop.rollup.number;
        }

        if (num !== null) values.push(num);
      }
    } catch (innerError) {
      console.error("Aggregation Query Error:", innerError.response?.data || innerError.message);
    }

    if (values.length === 0) return 0;

    if (calc === "sum") return values.reduce((a, b) => a + b, 0);
    if (calc === "average") return values.reduce((a, b) => a + b, 0) / values.length;
    if (calc === "count") return values.length;
    if (calc === "min") return Math.min(...values);
    if (calc === "max") return Math.max(...values);
    
    return 0;
  } catch (error) {
    console.error("Critical Aggregation Error:", error.message);
    return null;
  }
}

// --- API: LIST DATABASES ---
app.get('/api/databases', requireAuth, async (req, res) => {
  console.log("1. Starting Database Search request...");
  try {
    const uRes = await pool.query("SELECT access_token FROM users WHERE id = $1", [req.session.userId]);
    const user = uRes.rows[0];
    
    if (!user) {
      return res.status(401).json({ error: "User not found" });
    }

    const response = await axios.post('https://api.notion.com/v1/search', 
      {
        filter: { value: 'database', property: 'object' },
        sort: { direction: 'descending', timestamp: 'last_edited_time' }
      },
      {
        headers: {
          'Authorization': `Bearer ${user.access_token}`,
          'Notion-Version': NOTION_VERSION,
          'Content-Type': 'application/json'
        }
      }
    );

    const databases = response.data.results.map(db => ({
      id: db.id,
      title: db.title && db.title.length > 0 ? db.title[0].plain_text : "Untitled Database",
      icon: db.icon ? (db.icon.emoji || "📄") : "📄"
    }));

    res.json(databases);
  } catch (error) {
    console.error("❌ SEARCH ERROR:", error.message);
    res.status(500).json({ error: "Failed to fetch databases" });
  }
});

// --- API: GET DATABASE PROPERTIES ---
app.get('/api/properties', requireAuth, async (req, res) => {
  const { dbId } = req.query;
  if (!dbId) return res.status(400).json({ error: "Missing dbId" });

  try {
    const uRes = await pool.query("SELECT access_token FROM users WHERE id = $1", [req.session.userId]);
    const user = uRes.rows[0];
    if (!user) return res.status(401).json({ error: "User not found" });

    const response = await axios.get(`https://api.notion.com/v1/databases/${dbId}`, {
      headers: {
        'Authorization': `Bearer ${user.access_token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json'
      }
    });

    const properties = response.data.properties;
    const validProps = [];

    // Filter for Number, Formula, and Rollup
    for (const [key, prop] of Object.entries(properties)) {
       if (prop.type === 'number' || prop.type === 'formula' || prop.type === 'rollup') {
         validProps.push(key);
       }
    }

    res.json(validProps);
  } catch (error) {
    console.error("Property Fetch Error:", error.response?.data || error.message);
    res.status(500).json({ error: "Failed to fetch properties" });
  }
});

// --- UI: LOGIN ---
app.get('/login', (req, res) => {
  res.send(`
    <html>
      <head>
        <title>Cookie Card Login</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        <style>
          body { background-color: #F8F9FE; height: 100vh; display: flex; align-items: center; justify-content: center; }
          .login-card { background: white; border-radius: 15px; box-shadow: 0 4px 20px rgba(0,0,0,0.05); padding: 40px; text-align: center; max-width: 400px; width: 100%; border-top: 5px solid #C69C6D; }
          .btn-cookie { background-color: #4A3B32; color: #fff; border: none; padding: 10px 20px; border-radius: 5px; font-weight: 600; width: 100%; transition: all 0.2s; }
          .logo-text { font-weight: 800; color: #4A3B32; font-size: 24px; margin-bottom: 5px; }
          .sub-text { color: #8898aa; font-size: 14px; margin-bottom: 30px; }
        </style>
      </head>
      <body>
        <div class="login-card">
           <div class="logo-text">🍪 Cookie Card</div>
           <div class="sub-text">Brought to you by Digital Cookie</div>
           <p style="color:#525f7f; margin-bottom:30px;">Turn your Notion databases into beautiful dashboard widgets.</p>
           <a href="/auth/notion" class="btn btn-cookie">Connect Notion Workspace</a>
        </div>
      </body>
    </html>
  `);
});

app.get('/auth/notion', (req, res) => {
  const notionAuthUrl = `https://api.notion.com/v1/oauth/authorize?client_id=${NOTION_CLIENT_ID}&response_type=code&owner=user&redirect_uri=${encodeURIComponent(NOTION_REDIRECT_URI)}`;
  res.redirect(notionAuthUrl);
});

app.get('/auth/notion/callback', async (req, res) => {
  const code = req.query.code;
  if (!code) return res.send("Error: No code");

  try {
    const authString = Buffer.from(`${NOTION_CLIENT_ID}:${NOTION_CLIENT_SECRET}`).toString('base64');
    const response = await axios.post('https://api.notion.com/v1/oauth/token', {
      grant_type: 'authorization_code',
      code: code,
      redirect_uri: NOTION_REDIRECT_URI
    }, {
      headers: { 'Authorization': `Basic ${authString}`, 'Content-Type': 'application/json' }
    });

    const { access_token, bot_id, owner, workspace_name } = response.data;
    const userId = owner.user.id; 

    await pool.query(`
      INSERT INTO users (id, access_token, workspace_name, bot_id)
      VALUES ($1, $2, $3, $4)
      ON CONFLICT (id) DO UPDATE SET access_token = $2, workspace_name = $3;
    `, [userId, access_token, workspace_name || "My Workspace", bot_id]);

    req.session.userId = userId;
    res.redirect('/');
  } catch (error) {
    console.error("Login Callback Error:", error.message);
    res.send("Error logging in.");
  }
});

app.get('/logout', (req, res) => {
  req.session = null;
  res.redirect('/login');
});

// --- UI: DASHBOARD ---
app.get("/", requireAuth, async (req, res) => {
  const userId = req.session.userId;
  const result = await pool.query("SELECT * FROM widgets WHERE user_id = $1", [userId]);
  const widgets = result.rows;
  const baseUrl = `${req.headers['x-forwarded-proto'] || req.protocol}://${req.headers.host}`;

  const cardsHtml = widgets.map(w => `
    <div class="col-md-4 mb-4">
      <div class="card widget-card h-100">
        <div class="card-body">
          <div class="row">
            <div class="col">
              <h5 class="card-title text-uppercase text-muted mb-0">${w.title}</h5>
              <span class="h2 font-weight-bold mb-0 text-cookie-dark">${w.db_id ? "Live Data" : "Setup Needed"}</span>
            </div>
          </div>
          <p class="mt-3 mb-0 text-muted text-sm">
            <span class="text-success mr-2"> ${w.calculation || 'Sum'}</span>
            <span class="text-nowrap">${w.subtext}</span>
          </p>
          <div class="mt-3">
             <input type="text" value="${baseUrl}/embed/${w.id}" class="form-control form-control-sm mb-2" readonly onclick="this.select()">
             <div class="d-flex justify-content-between">
                <a href="/edit/${w.id}" class="btn btn-sm btn-outline-cookie">Edit</a>
                <form action="/delete" method="POST" class="d-inline">
                  <input type="hidden" name="id" value="${w.id}">
                  <button type="submit" class="btn btn-sm btn-outline-danger">Delete</button>
                </form>
             </div>
          </div>
        </div>
      </div>
    </div>
  `).join("");

  res.send(`
    <!DOCTYPE html>
    <html>
      <head>
        <title>Cookie Card Dashboard</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        <script src="https://unpkg.com/feather-icons"></script>
        <style>
          :root {
            --cookie-primary: #C69C6D;
            --cookie-dark: #4A3B32;
            --bg-light: #F8F9FE;
          }
          body { background-color: var(--bg-light); font-family: 'Open Sans', sans-serif; }
          
          /* Sidebar */
          .sidebar {
            height: 100vh;
            position: fixed;
            top: 0; left: 0;
            width: 250px;
            background: white;
            box-shadow: 0 0 2rem 0 rgba(136, 152, 170, .15);
            z-index: 100;
            padding-top: 20px;
          }
          .sidebar .nav-link { color: #525f7f; font-weight: 600; padding: 1rem 1.5rem; display: flex; align-items: center; }
          .sidebar .nav-link.active { color: var(--cookie-primary); background: rgba(198, 156, 109, 0.1); border-right: 4px solid var(--cookie-primary); }
          .sidebar .nav-link i { margin-right: 10px; }
          .brand-text { font-size: 22px; font-weight: 800; color: var(--cookie-dark); padding: 0 1.5rem; margin-bottom: 2rem; }
          .brand-sub { font-size: 11px; color: #8898aa; text-transform: uppercase; letter-spacing: 1px; padding: 0 1.5rem; margin-top: -20px; margin-bottom: 30px; display:block;}
          
          /* Main Content */
          .main-content { margin-left: 250px; padding: 30px; }
          
          /* Cards */
          .widget-card { border: none; border-radius: 1rem; box-shadow: 0 0 2rem 0 rgba(136, 152, 170, .15); transition: transform 0.2s; }
          .widget-card:hover { transform: translateY(-5px); }
          .bg-cookie { background-color: var(--cookie-primary) !important; }
          .text-cookie-dark { color: var(--cookie-dark) !important; }
          .btn-cookie { background-color: var(--cookie-dark); color: white; border:none; }
          .btn-cookie:hover { background-color: var(--cookie-primary); color: white; }
          .btn-outline-cookie { color: var(--cookie-dark); border-color: var(--cookie-dark); }
          .btn-outline-cookie:hover { background-color: var(--cookie-dark); color: white; }
          
          /* Form Card */
          .create-card { background: white; border-radius: 1rem; padding: 25px; border: 1px solid rgba(0,0,0,0.05); margin-bottom: 30px; }
        </style>
      </head>
      <body>
        <div class="sidebar d-none d-md-block">
           <div class="brand-text">🍪 Cookie Card</div>
           <span class="brand-sub">by Digital Cookie</span>
           <ul class="nav flex-column">
             <li class="nav-item">
               <a class="nav-link active" href="/"><i data-feather="grid"></i> Dashboard</a>
             </li>
             <li class="nav-item">
               <a class="nav-link" href="/logout"><i data-feather="log-out"></i> Logout</a>
             </li>
           </ul>
        </div>

        <div class="main-content">
           <div class="d-flex justify-content-between align-items-center mb-4">
              <h2 class="text-cookie-dark font-weight-bold">Dashboard</h2>
              <button class="btn btn-cookie" type="button" data-bs-toggle="collapse" data-bs-target="#createForm">
                <i data-feather="plus"></i> New Widget
              </button>
           </div>

           <div class="collapse mb-4" id="createForm">
             <div class="create-card shadow-sm">
                <h4 class="mb-4 text-cookie-dark">Create New Widget</h4>
                <form action="/add" method="POST">
                  <div class="row g-3">
                    <div class="col-md-4">
                      <label class="form-label text-muted small fw-bold">Title</label>
                      <input type="text" name="title" class="form-control" placeholder="Total Revenue" required>
                    </div>
                    <div class="col-md-2">
                       <label class="form-label text-muted small fw-bold">Prefix</label>
                       <input type="text" name="prefix" class="form-control" placeholder="$">
                    </div>
                    <div class="col-md-6">
                       <label class="form-label text-muted small fw-bold">Subtext</label>
                       <input type="text" name="subtext" class="form-control" placeholder="vs last month" required>
                    </div>
                    
                    <div class="col-12"><hr class="text-muted"></div>
                    
                    <div class="col-md-6">
                       <label class="form-label text-primary small fw-bold">Source Database</label>
                       <select name="dbId" id="dbSelect" class="form-select" onchange="loadProperties(this.value)">
                          <option value="" selected>Loading...</option>
                       </select>
                    </div>
                    <div class="col-md-4">
                       <label class="form-label text-primary small fw-bold">Target Property</label>
                       <select name="property" id="propSelect" class="form-select" disabled>
                          <option value="" selected>Select Database First</option>
                       </select>
                    </div>
                    <div class="col-md-2">
                       <label class="form-label text-primary small fw-bold">Calculation</label>
                       <select name="calculation" class="form-select">
                          <option value="sum">Sum</option>
                          <option value="average">Average</option>
                          <option value="count">Count</option>
                          <option value="min">Min</option>
                          <option value="max">Max</option>
                       </select>
                    </div>
                  </div>
                  <div class="mt-4 text-end">
                     <button type="button" class="btn btn-light" data-bs-toggle="collapse" data-bs-target="#createForm">Cancel</button>
                     <button type="submit" class="btn btn-cookie px-4">Create Widget</button>
                  </div>
                </form>
             </div>
           </div>

           <div class="row">
              ${cardsHtml}
           </div>
           
           ${widgets.length === 0 ? '<div class="text-center text-muted mt-5"><p>No widgets yet. Click "New Widget" to start.</p></div>' : ''}
        </div>

        <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/js/bootstrap.bundle.min.js"></script>
        <script>
          feather.replace();

          async function loadDatabases() {
            const select = document.getElementById('dbSelect');
            try {
              const res = await fetch('/api/databases');
              const dbs = await res.json();
              select.innerHTML = '<option value="">-- Select Database --</option>';
              dbs.forEach(db => {
                const option = document.createElement('option');
                option.value = db.id;
                option.innerText = db.icon + " " + db.title;
                select.appendChild(option);
              });
            } catch (e) { select.innerHTML = '<option>Error loading</option>'; }
          }

          async function loadProperties(dbId) {
             const select = document.getElementById('propSelect');
             select.innerHTML = '<option value="">Loading...</option>';
             select.disabled = true;
             
             if(!dbId) {
                select.innerHTML = '<option value="">Select Database First</option>';
                return;
             }

             try {
               constQXres = await fetch('/api/properties?dbId=' + dbId);
               const props = awaitQXres.json();
               
               if (props.length === 0) {
                   select.innerHTML = '<option value="">No Number Properties Found</option>';
                   return;
               }

               select.innerHTML = '<option value="">-- Select Property --</option>';
               props.forEach(p => {
                 const opt = document.createElement('option');
                 opt.value = p;
                 opt.innerText = p;
                 select.appendChild(opt);
               });
               select.disabled = false;
             } catch(e) { 
                 console.log("Error fetching properties"); 
                 select.innerHTML = '<option>Error</option>';
             }
          }

          loadDatabases();
        </script>
      </body>
    </html>
  `);
});

// --- UI: EDIT PAGE ---
app.get("/edit/:id", requireAuth, async (req, res) => {
  const result = await pool.query("SELECT * FROM widgets WHERE id = $1 AND user_id = $2", [req.params.id, req.session.userId]);
  const w = result.rows[0];
  if (!w) return res.send("Widget not found.");
  
  const isSel = (val) => (w.calculation === val ? 'selected' : '');

  res.send(`
    <html>
      <head>
        <title>Edit Widget</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.0/dist/css/bootstrap.min.css" rel="stylesheet">
        <style>
           body { background: #F8F9FE; font-family: sans-serif; padding: 40px; }
           .edit-card { background: white; border-radius: 1rem; max-width: 800px; margin: 0 auto; padding: 40px; box-shadow: 0 0 20px rgba(0,0,0,0.05); }
           .btn-cookie { background-color: #4A3B32; color: white; }
           .btn-cookie:hover { background-color: #C69C6D; color: white; }
        </style>
      </head>
      <body>
         <div class="edit-card">
            <h3 class="mb-4 text-center" style="color:#4A3B32;">Edit Widget</h3>
            <form action="/update" method="POST">
               <input type="hidden" name="id" value="${w.id}">
               
               <div class="row g-3">
                  <div class="col-md-6">
                    <label class="form-label fw-bold small">Title</label>
                    <input type="text" name="title" class="form-control" value="${w.title}" required>
                  </div>
                  <div class="col-md-6">
                     <label class="form-label fw-bold small">Prefix</label>
                     <input type="text" name="prefix" class="form-control" value="${w.prefix||''}">
                  </div>
                  <div class="col-12">
                     <label class="form-label fw-bold small">Subtext</label>
                     <input type="text" name="subtext" class="form-control" value="${w.subtext}" required>
                  </div>

                  <div class="col-12"><hr></div>
                  
                  <div class="col-md-6">
                     <label class="form-label text-primary fw-bold small">Database</label>
                     <select name="dbId" id="dbSelect" class="form-select" data-selected="${w.db_id||''}" onchange="loadProperties(this.value)">
                        <option value="">Loading...</option>
                     </select>
                  </div>
                  <div class="col-md-6">
                     <label class="form-label text-primary fw-bold small">Property</label>
                     <select name="property" id="propSelect" class="form-select" data-selected="${w.property||''}">
                        <option value="">Loading...</option>
                     </select>
                  </div>
                  
                  <div class="col-12">
                     <label class="form-label text-primary fw-bold small">Calculation</label>
                     <select name="calculation" class="form-select">
                        <option value="sum" ${isSel('sum')}>Sum</option>
                        <option value="average" ${isSel('average')}>Average</option>
                        <option value="count" ${isSel('count')}>Count</option>
                        <option value="min" ${isSel('min')}>Min</option>
                        <option value="max" ${isSel('max')}>Max</option>
                     </select>
                  </div>
               </div>

               <div class="mt-4 d-flex justify-content-between">
                  <a href="/" class="btn btn-outline-secondary">Cancel</a>
                  <button type="submit" class="btn btn-cookie px-5">Save Changes</button>
               </div>
            </form>
         </div>
         
         <script>
           async function loadDatabases() {
              const select = document.getElementById('dbSelect');
              const currentId = select.getAttribute('data-selected');
              try {
                const res = await fetch('/api/databases');
                const dbs = await res.json();
                select.innerHTML = '<option value="">-- Select --</option>';
                dbs.forEach(db => {
                  const opt = document.createElement('option');
                  opt.value = db.id;
                  opt.innerText = db.icon + " " + db.title;
                  if(db.id === currentId) opt.selected = true;
                  select.appendChild(opt);
                });
                
                if(currentId) loadProperties(currentId);
                
              } catch(e) {}
           }
           
           async function loadProperties(dbId) {
             const select = document.getElementById('propSelect');
             const currentProp = select.getAttribute('data-selected');
             
             select.innerHTML = '<option value="">Loading...</option>';
             select.disabled = true;
             
             if(!dbId) return;

             try {
               const res = await fetch('/api/properties?dbId=' + dbId);
               const props = await res.json();
               
               select.innerHTML = '<option value="">-- Select Property --</option>';
               props.forEach(p => {
                 const opt = document.createElement('option');
                 opt.value = p;
                 opt.innerText = p;
                 if(p === currentProp) opt.selected = true;
                 select.appendChild(opt);
               });
               select.disabled = false;
             } catch(e) {}
           }
           loadDatabases();
         </script>
      </body>
    </html>
  `);
});

// --- ACTIONS ---
app.post("/add", requireAuth, async (req, res) => {
  const { title, icon, prefix, subtext, dbId, property, manualValue, calculation } = req.body;
  
  // 1. Check current count
  const countRes = await pool.query("SELECT COUNT(*) FROM widgets WHERE user_id = $1", [req.session.userId]);
  const widgetCount = parseInt(countRes.rows[0].count);

  if (widgetCount >= 3) {
    // If limit reached, send a simple error page or redirect
    return res.send(`
      <body style="font-family:sans-serif; text-align:center; padding:50px; background:#F8F9FE;">
        <h2 style="color:#4A3B32;">🚫 Limit Reached</h2>
        <p>You can only create 3 widgets on the free plan.</p>
        <a href="/" style="background:#C69C6D; color:white; padding:10px 20px; text-decoration:none; border-radius:5px;">Back to Dashboard</a>
      </body>
    `);
  }

  // 2. If under limit, create the widget
  const id = uuidv4();
  await pool.query(
    `INSERT INTO widgets (id, user_id, title, icon, prefix, subtext, db_id, property, manual_value, calculation)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
    [id, req.session.userId, title, icon, prefix, subtext, dbId || null, property || null, manualValue || "0", calculation || "sum"]
  );
  res.redirect("/");
});

app.post("/update", requireAuth, async (req, res) => {
  const { id, title, prefix, subtext, dbId, property, calculation } = req.body;
  await pool.query(
    `UPDATE widgets SET title=$1, prefix=$2, subtext=$3, db_id=$4, property=$5, calculation=$6 
     WHERE id=$7 AND user_id=$8`,
    [title, prefix, subtext, dbId || null, property || null, calculation || "sum", id, req.session.userId]
  );
  res.redirect("/");
});

app.post("/delete", requireAuth, async (req, res) => {
  await pool.query("DELETE FROM widgets WHERE id = $1 AND user_id = $2", [req.body.id, req.session.userId]);
  res.redirect("/");
});

// --- PUBLIC EMBED ---
app.get("/embed/:id", async (req, res) => {
  const wRes = await pool.query("SELECT * FROM widgets WHERE id = $1", [req.params.id]);
  const widget = wRes.rows[0];
  if (!widget) return res.send("Widget not found");

  const uRes = await pool.query("SELECT access_token FROM users WHERE id = $1", [widget.user_id]);
  const user = uRes.rows[0];
  if (!user) return res.send("Owner not found");

  let finalNumber = 0;
  if (widget.db_id) {
    const agg = await getNotionAggregatedValue(user.access_token, widget.db_id, widget.property, widget.calculation);
    if (agg !== null) finalNumber = agg;
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
        <style>
          :root { --card-bg: #FFFFFF; --card-border: #E0E0E0; --text-title: #787774; --text-value: #37352F; --text-sub: #9B9A97; }
          @media (prefers-color-scheme: dark) { :root { --card-bg: #202020; --card-border: #333333; --text-title: #AFAFAF; --text-value: #FFFFFF; --text-sub: #808080; } }
          body { margin: 0; padding: 10px; overflow: hidden; background-color: transparent; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Helvetica, sans-serif; }
          .card { background-color: var(--card-bg); border: 1px solid var(--card-border); border-radius: 8px; height: calc(100vh - 20px); padding: 20px; box-sizing: border-box; display: flex; flex-direction: column; justify-content: center; }
          .title { font-size: 13px; font-weight: 600; color: var(--text-title); text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 8px; }
          .value { font-size: 38px; font-weight: 700; color: var(--text-value); margin-bottom: 6px; letter-spacing: -0.5px; line-height: 1; }
          .subtext { font-size: 13px; color: var(--text-sub); }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="title">${widget.title}</div>
          <div class="value">${fullDisplay}</div>
          <div class="subtext">${widget.subtext}</div>
        </div>
      </body>
    </html>
  `);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));