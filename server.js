const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');
// PostgreSQL module - graceful fallback for local development
let Pool = null;
try {
  Pool = require('pg').Pool;
} catch (error) {
  console.log('⚠️ PostgreSQL module not found - using file storage only');
}

const PORT = process.env.PORT || 3000;
const PASSWORD = 'babywolfdog';

// Force HTTPS redirect in production
const isProduction = process.env.NODE_ENV === 'production' || process.env.RAILWAY_ENVIRONMENT;

// Teller.io configuration
const TELLER_CONFIG = {
    applicationId: 'app_pn2qum0p0bom9ppvn0000',
    publicKey: 'cXLqnm451Bi1sMtKTPWOwdFz3gMtNYPn2hVkgXxy9gc=',
    environment: 'development' // Now with client certificates for real bank data
};

// PostgreSQL connection setup
const DATABASE_URL = process.env.DATABASE_URL;
console.log(`🗄️ Database URL: ${DATABASE_URL ? 'Connected' : 'Missing - add PostgreSQL service'}`);

let pool = null;
if (DATABASE_URL && Pool) {
  try {
    pool = new Pool({
      connectionString: DATABASE_URL,
      ssl: DATABASE_URL.includes('railway.app') ? { rejectUnauthorized: false } : false
    });
    console.log('✅ PostgreSQL pool created successfully');
    try {
      console.log('🔗 Database URL host:', new URL(DATABASE_URL).hostname);
    } catch (e) {
      console.log('🔗 Database URL format issue');
    }

    // Test the connection
    pool.query('SELECT NOW()', (err, res) => {
      if (err) {
        console.error('❌ Database connection test failed:', err.message);
      } else {
        console.log('✅ Database connection test successful:', res.rows[0].now);
      }
    });
  } catch (error) {
    console.error('❌ Failed to create PostgreSQL pool:', error.message);
    pool = null;
  }
} else if (!Pool) {
  console.log('⚠️ PostgreSQL module not available - using file storage only');
} else {
  console.log('⚠️ No DATABASE_URL - using in-memory storage only');
}

// Initialize database tables
async function initializeDatabase() {
  if (!pool) return;

  try {
    await pool.query(`
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY,
        enrollment_token TEXT,
        institution_name TEXT,
        account_name TEXT,
        account_type TEXT,
        subtype TEXT,
        last_four TEXT,
        status TEXT DEFAULT 'connected',
        connected_at TIMESTAMP DEFAULT NOW()
      );
    `);

    // Add status column if it doesn't exist (for existing databases)
    await pool.query(`
      ALTER TABLE accounts ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'connected';
    `).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        description TEXT,
        amount DECIMAL,
        date TEXT,
        status TEXT,
        category TEXT,
        assigned_month TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY(account_id) REFERENCES accounts(id)
      );
    `);

    // Add assigned_month column if it doesn't exist (for existing databases)
    await pool.query(`
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS assigned_month TEXT;
    `).catch(() => {});

    // Add original_date column if it doesn't exist (for existing databases)
    await pool.query(`
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS original_date TEXT;
    `).catch(() => {});

    // Add bank column for manual transactions
    await pool.query(`
      ALTER TABLE transactions ADD COLUMN IF NOT EXISTS bank TEXT;
    `).catch(() => {});

    // Create placeholder account for manual transactions (to satisfy foreign key)
    await pool.query(`
      INSERT INTO accounts (id, institution_name, status, connected_at)
      VALUES ('manual', 'Manual Entry', 'active', NOW())
      ON CONFLICT (id) DO NOTHING;
    `).catch(() => {});

    await pool.query(`
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        authenticated BOOLEAN DEFAULT true,
        created_at TIMESTAMP DEFAULT NOW(),
        expires_at TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS budgets (
        id SERIAL PRIMARY KEY,
        category TEXT NOT NULL,
        month TEXT NOT NULL,
        amount DECIMAL NOT NULL,
        created_at TIMESTAMP DEFAULT NOW(),
        updated_at TIMESTAMP DEFAULT NOW(),
        UNIQUE(category, month)
      );
    `);

    console.log('✅ Database tables initialized');

    // Keep existing transactions - don't delete anything
  } catch (error) {
    console.error('❌ Database initialization failed:', error);
  }
}

// In-memory storage for quick access
const connectedAccounts = new Map();
const transactions = new Map();

// Load data from PostgreSQL database on startup
async function loadFromDatabase() {
  if (!pool) {
    console.log('🏦 No database - starting with fresh data');
    return;
  }

  try {
    // Load accounts
    const accountsResult = await pool.query('SELECT * FROM accounts');
    accountsResult.rows.forEach(row => {
      connectedAccounts.set(row.id, {
        id: row.id,
        enrollmentToken: row.enrollment_token,
        institutionName: row.institution_name,
        accountName: row.account_name,
        accountType: row.account_type,
        subtype: row.subtype,
        lastFour: row.last_four,
        status: row.status || 'connected',
        connectedAt: row.connected_at
      });
    });
    console.log(`🏦 Loaded ${connectedAccounts.size} accounts from PostgreSQL`);

    // Load transactions
    const transactionsResult = await pool.query('SELECT * FROM transactions');
    transactionsResult.rows.forEach(row => {
      transactions.set(row.id, {
        id: row.id,
        accountId: row.account_id,
        description: row.description,
        amount: parseFloat(row.amount),
        date: row.date,
        originalDate: row.original_date,
        status: row.status,
        category: row.category,
        assignedMonth: row.assigned_month,
        bank: row.bank,
        createdAt: row.created_at
      });
    });
    console.log(`📊 Loaded ${transactions.size} transactions from PostgreSQL`);

  } catch (error) {
    console.error('Failed to load from database:', error);
    console.log('Starting with fresh data');
  }
}

// Delete transactions before 2026-01-01
async function cleanupOldTransactions() {
  if (!pool) return;

  try {
    const result = await pool.query("DELETE FROM transactions WHERE date < '2026-01-01'");
    if (result.rowCount > 0) {
      console.log(`🗑️ Deleted ${result.rowCount} transactions before 2026-01-01`);
    }
  } catch (error) {
    console.error('Failed to cleanup old transactions:', error);
  }
}

// Initialize and load data on startup
(async () => {
  if (pool) {
    console.log('🔄 Initializing PostgreSQL database...');
    await initializeDatabase();
    await cleanupOldTransactions();
    await loadFromDatabase();
    await loadSessionsFromDB();
  } else {
    console.log('📁 Using file storage mode - no database available');
  }
})();

// Persistent storage using filesystem
// Use persistent storage directory if available (Railway), otherwise local files
const dataDir = process.env.RAILWAY_VOLUME_MOUNT_PATH || '.';
const sessionFile = path.join(dataDir, 'sessions.json');
const accountsFile = path.join(dataDir, 'accounts.json');
const transactionsFile = path.join(dataDir, 'transactions.json');

// Ensure data directory exists
function ensureDataDir() {
  if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
    console.log(`📁 Created data directory: ${dataDir}`);
  }
}

// Load sessions from file (fallback)
function loadSessions() {
  try {
    ensureDataDir();
    if (fs.existsSync(sessionFile)) {
      const data = fs.readFileSync(sessionFile, 'utf8');
      const sessionData = JSON.parse(data);
      return new Map(Object.entries(sessionData));
    }
  } catch (error) {
    console.log('No existing sessions file, starting fresh');
  }
  return new Map();
}

// Load sessions from PostgreSQL
async function loadSessionsFromDB() {
  if (!pool) return;
  try {
    const result = await pool.query('SELECT * FROM sessions WHERE expires_at > NOW()');
    result.rows.forEach(row => {
      sessions.set(row.id, {
        authenticated: row.authenticated,
        createdAt: row.created_at,
        expiresAt: row.expires_at
      });
    });
    console.log(`🔐 Loaded ${sessions.size} sessions from PostgreSQL`);
  } catch (error) {
    console.error('Failed to load sessions from database:', error);
  }
}

// Save sessions to file (fallback) and database
function saveSessions(sessionsMap) {
  // Save to file as backup
  try {
    const sessionData = Object.fromEntries(sessionsMap);
    fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
  } catch (error) {
    console.error('Error saving sessions to file:', error);
  }
}

// Save single session to PostgreSQL
async function saveSessionToDB(sessionId, sessionData) {
  if (!pool) return;
  try {
    await pool.query(
      `INSERT INTO sessions (id, authenticated, created_at, expires_at)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO UPDATE SET
         authenticated = $2,
         expires_at = $4`,
      [sessionId, sessionData.authenticated, new Date(sessionData.createdAt), new Date(sessionData.expiresAt)]
    );
  } catch (error) {
    console.error('Failed to save session to database:', error);
  }
}

// Delete session from PostgreSQL
async function deleteSessionFromDB(sessionId) {
  if (!pool) return;
  try {
    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionId]);
  } catch (error) {
    console.error('Failed to delete session from database:', error);
  }
}

// Load accounts from file
function loadAccounts() {
  try {
    if (fs.existsSync(accountsFile)) {
      const data = fs.readFileSync(accountsFile, 'utf8');
      const accountsData = JSON.parse(data);
      return new Map(Object.entries(accountsData));
    }
  } catch (error) {
    console.error('❌ Failed to load accounts:', error);
  }
  return new Map();
}

// Save accounts to file
function saveAccounts(accounts) {
  try {
    ensureDataDir();
    const accountsData = Object.fromEntries(accounts);
    fs.writeFileSync(accountsFile, JSON.stringify(accountsData, null, 2));
    console.log(`📝 Connected accounts saved to ${accountsFile}`);
  } catch (error) {
    console.error('❌ Failed to save accounts:', error);
  }
}

// Load transactions from file
function loadTransactions() {
  try {
    if (fs.existsSync(transactionsFile)) {
      const data = fs.readFileSync(transactionsFile, 'utf8');
      const transactionsData = JSON.parse(data);
      return new Map(Object.entries(transactionsData));
    }
  } catch (error) {
    console.error('❌ Failed to load transactions:', error);
  }
  return new Map();
}

// Save transactions to file
function saveTransactions(transactionsMap) {
  try {
    ensureDataDir();
    const transactionsData = Object.fromEntries(transactionsMap);
    fs.writeFileSync(transactionsFile, JSON.stringify(transactionsData, null, 2));
    console.log(`💾 Transactions saved to ${transactionsFile}`);
  } catch (error) {
    console.error('❌ Failed to save transactions:', error);
  }
}

const sessions = loadSessions();

// Load connected accounts from files as fallback
if (!pool) {
  const savedAccounts = loadAccounts();
  savedAccounts.forEach((account, id) => {
    connectedAccounts.set(id, account);
  });
  console.log(`🏦 Loaded ${connectedAccounts.size} connected accounts from files`);

  // Load transactions from files as fallback
  const savedTransactions = loadTransactions();
  savedTransactions.forEach((transaction, id) => {
    transactions.set(id, transaction);
  });
  console.log(`📊 Loaded ${transactions.size} transactions from files`);
}

// Simple session management
function generateSessionId() {
  return Math.random().toString(36).substr(2, 9);
}

function isAuthenticated(req) {
  const cookies = parseCookies(req.headers.cookie || '');
  const sessionId = cookies.sessionId;

  if (!sessionId || !sessions.has(sessionId)) {
    return false;
  }

  const session = sessions.get(sessionId);

  // Check if session has expired
  if (session.expiresAt && new Date() > new Date(session.expiresAt)) {
    sessions.delete(sessionId);
    saveSessions(sessions);
    deleteSessionFromDB(sessionId); // Fire and forget
    return false;
  }

  return session.authenticated;
}

function parseCookies(cookieHeader) {
  const cookies = {};
  cookieHeader.split(';').forEach(cookie => {
    const parts = cookie.trim().split('=');
    if (parts.length === 2) {
      cookies[parts[0]] = parts[1];
    }
  });
  return cookies;
}

// MIME types
const mimeTypes = {
  '.html': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.json': 'application/json'
};

function getContentType(filePath) {
  const ext = path.extname(filePath);
  return mimeTypes[ext] || 'text/plain';
}

const server = http.createServer((req, res) => {
  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  // CORS headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  // API Routes
  if (pathname.startsWith('/api/')) {
    handleApiRequest(req, res, pathname);
    return;
  }

  // Static file serving
  if (pathname === '/') {
    serveFile(res, path.join(__dirname, 'index.html'), 'text/html');
  } else {
    const filePath = path.join(__dirname, pathname);
    if (fs.existsSync(filePath) && fs.statSync(filePath).isFile()) {
      serveFile(res, filePath, getContentType(filePath));
    } else {
      res.writeHead(404);
      res.end('File not found');
    }
  }
});

function serveFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(500);
      res.end('Server error');
      return;
    }
    res.setHeader('Content-Type', contentType);
    res.writeHead(200);
    res.end(data);
  });
}

function handleApiRequest(req, res, pathname) {
  if (pathname === '/api/auth/login' && req.method === 'POST') {
    handleLogin(req, res);
  } else if (pathname === '/api/auth/me' && req.method === 'GET') {
    handleAuthCheck(req, res);
  } else if (pathname === '/api/auth/logout' && req.method === 'POST') {
    handleLogout(req, res);
  } else if (pathname === '/api/teller/enrollment' && req.method === 'POST') {
    handleTellerEnrollment(req, res);
  } else if (pathname === '/api/teller/account' && req.method === 'POST') {
    handleTellerAccount(req, res);
  } else if (pathname === '/api/transactions/fetch' && req.method === 'POST') {
    handleFetchTransactions(req, res);
  } else if (pathname === '/api/transactions' && req.method === 'GET') {
    handleGetTransactions(req, res);
  } else if (pathname === '/api/transactions/update-category' && req.method === 'POST') {
    handleUpdateTransactionCategory(req, res);
  } else if (pathname === '/api/transactions/update-date' && req.method === 'POST') {
    handleUpdateTransactionDate(req, res);
  } else if (pathname === '/api/transactions/update-amount' && req.method === 'POST') {
    handleUpdateTransactionAmount(req, res);
  } else if (pathname === '/api/transactions/delete' && req.method === 'POST') {
    handleDeleteTransaction(req, res);
  } else if (pathname === '/api/transactions/manual' && req.method === 'POST') {
    handleCreateManualTransaction(req, res);
  } else if (pathname === '/api/accounts' && req.method === 'GET') {
    handleGetAccounts(req, res);
  } else if (pathname === '/api/account/delete' && req.method === 'POST') {
    handleDeleteAccount(req, res);
  } else if (pathname === '/api/account/details' && req.method === 'POST') {
    handleGetAccountDetails(req, res);
  } else if (pathname === '/api/transactions/clear' && req.method === 'POST') {
    handleClearTransactions(req, res);
  } else if (pathname === '/api/budgets/get' && req.method === 'POST') {
    handleGetBudget(req, res);
  } else if (pathname === '/api/budgets/save' && req.method === 'POST') {
    handleSaveBudget(req, res);
  } else {
    res.writeHead(404);
    res.end(JSON.stringify({ error: 'API endpoint not found' }));
  }
}

function handleLogin(req, res) {
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      if (data.password === PASSWORD) {
        const sessionId = generateSessionId();
        const sessionData = {
          authenticated: true,
          createdAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 90 * 24 * 60 * 60 * 1000).toISOString()
        };
        sessions.set(sessionId, sessionData);
        saveSessions(sessions);
        await saveSessionToDB(sessionId, sessionData);

        const isSecure = process.env.RAILWAY_ENVIRONMENT || process.env.NODE_ENV === 'production';
        const cookieOptions = `sessionId=${sessionId}; HttpOnly; Path=/; Max-Age=${90 * 24 * 60 * 60}; SameSite=Lax${isSecure ? '; Secure' : ''}`;
        res.setHeader('Set-Cookie', cookieOptions);
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, message: 'Login successful' }));
      } else {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(401);
        res.end(JSON.stringify({ error: 'Invalid password' }));
      }
    } catch (error) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Invalid request body' }));
    }
  });
}

function handleAuthCheck(req, res) {
  res.setHeader('Content-Type', 'application/json');
  if (isAuthenticated(req)) {
    res.writeHead(200);
    res.end(JSON.stringify({
      user: {
        id: 'shared_user',
        name: 'You & Your Wife',
        authenticated: true
      }
    }));
  } else {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Not authenticated' }));
  }
}

async function handleLogout(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  const sessionId = cookies.sessionId;
  if (sessionId) {
    sessions.delete(sessionId);
    saveSessions(sessions);
    await deleteSessionFromDB(sessionId);
  }
  res.setHeader('Content-Type', 'application/json');
  res.writeHead(200);
  res.end(JSON.stringify({ message: 'Logged out successfully' }));
}

function handleTellerEnrollment(req, res) {
  try {
    // Return Teller enrollment configuration
    const enrollmentData = {
      application_id: TELLER_CONFIG.applicationId,
      environment: TELLER_CONFIG.environment
    };

    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify(enrollmentData));
  } catch (error) {
    console.error('Teller enrollment error:', error);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Failed to generate enrollment token' }));
  }
}

async function handleTellerAccount(req, res) {
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const { accountId: enrollmentToken, institutionName } = data;
      console.log('Connected enrollment token:', { enrollmentToken, institutionName });

      // Immediately fetch REAL accounts from Teller - no placeholders
      const https = require('https');

      let cert, key;
      try {
        cert = fs.readFileSync('./certificate.pem');
        key = fs.readFileSync('./private_key.pem');
      } catch (error) {
        if (process.env.TELLER_CERT_B64 && process.env.TELLER_KEY_B64) {
          cert = Buffer.from(process.env.TELLER_CERT_B64, 'base64');
          key = Buffer.from(process.env.TELLER_KEY_B64, 'base64');
        } else {
          throw new Error('Certificate files not found');
        }
      }

      const options = {
        hostname: 'api.teller.io',
        path: '/accounts',
        method: 'GET',
        headers: {
          'Authorization': `Basic ${Buffer.from(enrollmentToken + ':').toString('base64')}`,
          'Accept': 'application/json'
        },
        cert: cert,
        key: key,
        rejectUnauthorized: false
      };

      const tellerReq = https.request(options, (tellerRes) => {
        let responseBody = '';
        tellerRes.on('data', chunk => responseBody += chunk);
        tellerRes.on('end', async () => {
          try {
            if (tellerRes.statusCode !== 200) {
              console.error('Teller API error:', tellerRes.statusCode, responseBody);
              res.writeHead(500);
              res.end(JSON.stringify({ error: 'Failed to fetch accounts from Teller' }));
              return;
            }

            const accounts = JSON.parse(responseBody);
            console.log(`📋 Found ${accounts.length} real accounts from Teller`);

            const savedAccounts = [];
            for (const acc of accounts) {
              const accountData = {
                id: acc.id,
                enrollmentToken: enrollmentToken,
                institutionName: acc.institution?.name || institutionName,
                accountName: acc.name || 'Account',
                accountType: acc.type || 'unknown',
                subtype: acc.subtype || 'unknown',
                lastFour: acc.last_four || '',
                status: 'connected',
                connectedAt: new Date().toISOString()
              };

              connectedAccounts.set(acc.id, accountData);
              savedAccounts.push(accountData);
              console.log(`✅ Stored: ${accountData.institutionName} - ${accountData.accountName} (****${accountData.lastFour})`);

              // Save to PostgreSQL
              if (pool) {
                try {
                  await pool.query(
                    `INSERT INTO accounts (id, enrollment_token, institution_name, account_name, account_type, subtype, last_four, status, connected_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                     ON CONFLICT (id) DO UPDATE SET
                       enrollment_token = $2,
                       institution_name = $3,
                       account_name = $4,
                       account_type = $5,
                       subtype = $6,
                       last_four = $7,
                       status = $8`,
                    [acc.id, enrollmentToken, accountData.institutionName, accountData.accountName, accountData.accountType, accountData.subtype, accountData.lastFour, 'connected', new Date()]
                  );
                } catch (dbError) {
                  console.error('Failed to save account:', dbError.message);
                }
              }
            }

            saveAccounts(connectedAccounts);

            res.setHeader('Content-Type', 'application/json');
            res.writeHead(200);
            res.end(JSON.stringify({
              success: true,
              message: `Connected ${savedAccounts.length} accounts`,
              accounts: savedAccounts
            }));

          } catch (parseError) {
            console.error('Error parsing Teller response:', parseError);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Failed to parse account data' }));
          }
        });
      });

      tellerReq.on('error', (error) => {
        console.error('Teller API request error:', error);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to connect to Teller' }));
      });

      tellerReq.end();

    } catch (error) {
      console.error('Save account error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to save account' }));
    }
  });
}

// Transaction categorization logic
function categorizeTransaction(description, amount) {
  const desc = description.toLowerCase();

  // Define category mappings
  const categories = {
    'Gas': { keywords: ['arco', 'chevron', 'shell', 'gas', 'fuel', 'exxon', 'bp'], emoji: '⛽', color: '#ff6b6b' },
    'Out & About': { keywords: ['restaurant', 'cafe', 'coffee', 'pizza', 'burger', 'food', 'kitchen', 'dining'], emoji: '🎉', color: '#ffbc5f' },
    'Grocery': { keywords: ['grocery', 'market', 'walmart', 'target', 'costco', 'supermarket'], emoji: '🛒', color: '#5fc4ff' },
    'Auto': { keywords: ['auto', 'mechanic', 'oil', 'tire', 'repair'], emoji: '🔧', color: '#4ecdc4' },
    'Clothing': { keywords: ['clothing', 'fashion', 'shirt', 'shoes', 'apparel'], emoji: '👕', color: '#ff9ff3' },
    'Gifts': { keywords: ['gift', 'present', 'birthday'], emoji: '🎁', color: '#feca57' },
    'Health & Care': { keywords: ['pharmacy', 'doctor', 'medical', 'health'], emoji: '🌿', color: '#48dbfb' },
    'Home': { keywords: ['home', 'furniture', 'decor', 'hardware', 'depot'], emoji: '🏠', color: '#0abde3' },
    'Travel': { keywords: ['uber', 'lyft', 'taxi', 'airline', 'hotel', 'travel', 'blick'], emoji: '✈️', color: '#00d2d3' },
    'Treats': { keywords: ['jones coffee', 'starbucks', 'dunkin', 'treats', 'dessert'], emoji: '🍭', color: '#ff9ff3' },
    'Personal Nick': { keywords: ['nick personal'], emoji: '👨', color: '#54a0ff' },
    'Personal Chelsea': { keywords: ['chelsea personal'], emoji: '👩', color: '#ff6348' },
    'School': { keywords: ['school', 'education', 'tuition'], emoji: '🎓', color: '#2ed573' },
    'Unsorted': { keywords: [], emoji: '📂', color: '#999999' }
  };

  for (const [categoryName, category] of Object.entries(categories)) {
    if (categoryName === 'Unsorted') continue;

    for (const keyword of category.keywords) {
      if (desc.includes(keyword)) {
        return {
          name: categoryName,
          emoji: category.emoji,
          color: category.color
        };
      }
    }
  }

  // Default to Unsorted
  return {
    name: 'Unsorted',
    emoji: '📂',
    color: '#999999'
  };
}

function handleFetchTransactions(req, res) {
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const { accountId } = data;

      if (!connectedAccounts.has(accountId)) {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Account not found' }));
        return;
      }

      const account = connectedAccounts.get(accountId);
      const enrollmentToken = account.enrollmentToken;
      console.log(`🔍 Fetching transactions for account ${accountId}`);

      // STEP 1: Get actual account IDs using enrollment token
      const https = require('https');

      // Try to load certificates from files, fallback to environment variables
      let cert, key;
      try {
        cert = fs.readFileSync('./certificate.pem');
        key = fs.readFileSync('./private_key.pem');
        console.log('✅ Loaded certificates from files');
      } catch (error) {
        // Fallback to environment variables for Railway deployment
        if (process.env.TELLER_CERT_B64 && process.env.TELLER_KEY_B64) {
          // Use base64 decoded certificates (complete with headers)
          cert = Buffer.from(process.env.TELLER_CERT_B64, 'base64');
          key = Buffer.from(process.env.TELLER_KEY_B64, 'base64');
          console.log('✅ Loaded certificates from base64 environment variables');
        } else {
          console.error('❌ No certificates found in files or environment variables');
          console.log('Available env vars:', Object.keys(process.env).filter(k => k.includes('TELLER')));
          throw new Error('Certificate files not found');
        }
      }

      const accountsOptions = {
        hostname: 'api.teller.io',
        path: '/accounts',
        method: 'GET',
        headers: {
          'Authorization': `Basic ${Buffer.from(enrollmentToken + ':').toString('base64')}`,
          'Accept': 'application/json'
        },
        cert: cert,
        key: key,
        rejectUnauthorized: false
      };

      const accountsReq = https.request(accountsOptions, (accountsRes) => {
        let accountsBody = '';

        accountsRes.on('data', (chunk) => {
          accountsBody += chunk;
        });

        accountsRes.on('end', async () => {
          try {
            if (accountsRes.statusCode !== 200) {
              console.error('❌ Teller accounts API error:', accountsRes.statusCode, accountsBody);

              // If 403/401, mark account as disconnected
              if (accountsRes.statusCode === 403 || accountsRes.statusCode === 401) {
                // Mark account as disconnected
                if (connectedAccounts.has(accountId)) {
                  const acc = connectedAccounts.get(accountId);
                  acc.status = 'disconnected';
                  connectedAccounts.set(accountId, acc);
                }
                if (pool) {
                  pool.query('UPDATE accounts SET status = $1 WHERE id = $2', ['disconnected', accountId])
                    .catch(err => console.error('Failed to update account status:', err));
                }

                res.setHeader('Content-Type', 'application/json');
                res.writeHead(200);
                res.end(JSON.stringify({
                  success: false,
                  disconnected: true,
                  message: 'This account needs to be reconnected',
                  accountId: accountId
                }));
                return;
              }

              // Other errors - load from memory as fallback
              const allTransactions = Array.from(transactions.values());

              res.setHeader('Content-Type', 'application/json');
              res.writeHead(200);
              res.end(JSON.stringify({
                success: true,
                message: `Loaded ${allTransactions.length} existing transactions`,
                transactions: allTransactions,
                count: allTransactions.length,
                newCount: 0
              }));
              return;
            }

            const accounts = JSON.parse(accountsBody);
            console.log('📋 Found accounts:', accounts.length);
            console.log('📋 Teller accounts data:', JSON.stringify(accounts, null, 2));

            // Store ALL accounts from Teller and fetch transactions from each
            console.log(`📋 Found ${accounts.length} accounts from Teller`);

            if (accounts.length === 0) {
              res.setHeader('Content-Type', 'application/json');
              res.writeHead(200);
              res.end(JSON.stringify({
                success: true,
                message: 'No accounts found',
                transactions: [],
                count: 0
              }));
              return;
            }

            // Store each account from Teller (mark as connected since API call succeeded)
            for (const acc of accounts) {
              console.log(`📋 Account: ${acc.institution?.name} - ${acc.name} (****${acc.last_four})`);

              // Use Teller account ID as the key for each sub-account
              const subAccountId = acc.id;
              const accountData = {
                id: subAccountId,
                enrollmentToken: enrollmentToken, // Use the ACTUAL enrollment token, not accountId!
                institutionName: acc.institution?.name || 'Unknown',
                accountName: acc.name || 'Account',
                accountType: acc.type || 'unknown',
                subtype: acc.subtype || 'unknown',
                lastFour: acc.last_four || '',
                status: 'connected',
                connectedAt: new Date().toISOString()
              };

              connectedAccounts.set(subAccountId, accountData);

              // Save to PostgreSQL - use enrollmentToken variable, not accountId!
              if (pool) {
                try {
                  await pool.query(
                    `INSERT INTO accounts (id, enrollment_token, institution_name, account_name, account_type, subtype, last_four, status, connected_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
                     ON CONFLICT (id) DO UPDATE SET
                       institution_name = $3,
                       account_name = $4,
                       account_type = $5,
                       subtype = $6,
                       last_four = $7,
                       status = $8`,
                    [subAccountId, enrollmentToken, accountData.institutionName, accountData.accountName, accountData.accountType, accountData.subtype, accountData.lastFour, 'connected', new Date()]
                  );
                } catch (dbErr) {
                  console.error('Failed to save account:', dbErr);
                }
              }
            }

            // STEP 2: Fetch transactions from ALL accounts
            const allTransactions = [];

            const fetchTransactionsForAccount = (acc) => {
              return new Promise((resolve, reject) => {
                console.log(`💳 Fetching transactions for: ${acc.institution?.name} - ${acc.name}`);

                const txnOptions = {
                  hostname: 'api.teller.io',
                  path: `/accounts/${acc.id}/transactions?from_date=2026-01-01`,
                  method: 'GET',
                  headers: {
                    'Authorization': `Basic ${Buffer.from(enrollmentToken + ':').toString('base64')}`,
                    'Accept': 'application/json'
                  },
                  cert: cert,
                  key: key,
                  rejectUnauthorized: false
                };

                const txnReq = https.request(txnOptions, (txnRes) => {
                  let txnBody = '';
                  txnRes.on('data', chunk => txnBody += chunk);
                  txnRes.on('end', () => {
                    if (txnRes.statusCode === 200) {
                      const txns = JSON.parse(txnBody);
                      console.log(`  ✅ Got ${txns.length} transactions from ${acc.institution?.name} - ${acc.name}`);
                      // Log first 3 raw transactions to see exact Teller data
                      if (txns.length > 0) {
                        console.log(`  📊 Sample raw Teller data for ${acc.institution?.name}:`);
                        txns.slice(0, 3).forEach(t => {
                          console.log(`    - "${t.description}" | raw_amount: ${t.amount} | type: ${t.type} | status: ${t.status}`);
                        });
                      }
                      resolve({ account: acc, transactions: txns });
                    } else {
                      console.error(`  ❌ Error fetching from ${acc.name}:`, txnRes.statusCode);
                      resolve({ account: acc, transactions: [] });
                    }
                  });
                });
                txnReq.on('error', reject);
                txnReq.end();
              });
            };

            // Fetch from all accounts in parallel
            const results = await Promise.all(accounts.map(fetchTransactionsForAccount));

            // Get existing transaction IDs and categories from DATABASE (not memory)
            let existingTxnData = new Map(); // id -> category
            if (pool) {
              try {
                const existing = await pool.query('SELECT id, category FROM transactions');
                existing.rows.forEach(row => {
                  existingTxnData.set(row.id, row.category || 'Unsorted');
                });
                console.log(`📊 Found ${existingTxnData.size} existing transactions in database`);
              } catch (dbErr) {
                console.error('Failed to fetch existing transactions:', dbErr);
              }
            }

            // Process all transactions - PRESERVE existing categories from DATABASE
            let newCount = 0;
            for (const result of results) {
              const acc = result.account;
              for (const txn of result.transactions) {
                // Skip pending transactions
                if (txn.status === 'pending') continue;

                // Check DATABASE for existing transaction
                const isNew = !existingTxnData.has(txn.id);
                const existingCategory = existingTxnData.get(txn.id) || 'Unsorted';

                if (isNew) newCount++;

                // BofA sends correct signs, other banks send positive - negate non-BofA only
                const isBofA = acc.institution?.name?.toLowerCase().includes('bank of america');
                const rawAmount = parseFloat(txn.amount);
                const finalAmount = isBofA ? rawAmount : -rawAmount;

                const transaction = {
                  id: txn.id,
                  accountId: acc.id,
                  description: txn.description,
                  amount: finalAmount,
                  date: txn.date,
                  status: txn.status,
                  category: existingCategory,
                  createdAt: new Date().toISOString()
                };

                transactions.set(txn.id, transaction);
                allTransactions.push(transaction);

                // Save to PostgreSQL - only insert new, preserve category on existing
                if (pool) {
                  pool.query(
                    `INSERT INTO transactions (id, account_id, description, amount, date, status, category, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     ON CONFLICT (id) DO UPDATE SET
                       account_id = $2,
                       description = $3,
                       amount = $4,
                       date = $5,
                       status = $6`,
                    [txn.id, acc.id, txn.description, finalAmount, txn.date, txn.status, 'Unsorted', new Date()]
                  ).catch(dbError => console.error('Failed to save transaction:', dbError));
                }
              }
            }

            // Save to JSON file for persistence
            saveTransactions(transactions);

            console.log(`🎉 Synced: ${newCount} new, ${allTransactions.length} total`);

            res.setHeader('Content-Type', 'application/json');
            res.writeHead(200);
            res.end(JSON.stringify({
              success: true,
              transactions: allTransactions,
              newCount: newCount,
              count: allTransactions.length
            }));
          } catch (error) {
            console.error('Error processing accounts:', error);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Failed to process accounts' }));
          }
        });
      });

      accountsReq.on('error', (error) => {
        console.error('Accounts API request error:', error);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to fetch accounts' }));
      });

      accountsReq.end();

    } catch (error) {
      console.error('Fetch transactions error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to fetch transactions' }));
    }
  });
}

function handleGetTransactions(req, res) {
  try {
    const allTransactions = Array.from(transactions.values())
      .map(txn => {
        // Add account info to each transaction
        const account = connectedAccounts.get(txn.accountId);
        const institutionName = account ? account.institutionName : 'Unknown';
        const lastFour = account && account.lastFour && account.lastFour !== '****' ? account.lastFour : '';
        return {
          ...txn,
          accountName: lastFour ? `${institutionName} ${lastFour}` : institutionName,
          accountLastFour: lastFour
        };
      })
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ transactions: allTransactions }));
  } catch (error) {
    console.error('Get transactions error:', error);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Failed to get transactions' }));
  }
}

async function handleClearTransactions(req, res) {
  try {
    const count = transactions.size;

    // Clear in-memory
    transactions.clear();

    // Clear database
    if (pool) {
      await pool.query('DELETE FROM transactions');
    }

    // Clear JSON file
    saveTransactions(transactions);

    console.log(`🗑️ Cleared ${count} transactions`);

    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ success: true, cleared: count }));
  } catch (error) {
    console.error('Clear transactions error:', error);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Failed to clear transactions' }));
  }
}

function handleGetAccounts(req, res) {
  try {
    const accounts = Array.from(connectedAccounts.values());
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ accounts }));
  } catch (error) {
    console.error('Get accounts error:', error);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Failed to get accounts' }));
  }
}

async function handleDeleteAccount(req, res) {
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', async () => {
    try {
      const { accountId } = JSON.parse(body);

      if (!accountId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Account ID required' }));
        return;
      }

      // Remove from memory
      connectedAccounts.delete(accountId);

      // Remove from database
      if (pool) {
        await pool.query('DELETE FROM accounts WHERE id = $1', [accountId]);
      }

      // Save to file backup
      saveAccounts(connectedAccounts);

      console.log(`🗑️ Deleted account: ${accountId}`);

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, message: 'Account removed' }));
    } catch (error) {
      console.error('Delete account error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to delete account' }));
    }
  });
}

function handleGetAccountDetails(req, res) {
  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', async () => {
    try {
      const data = JSON.parse(body);
      const { accountId } = data;

      const https = require('https');

      const options = {
        hostname: 'api.teller.io',
        path: `/accounts/${accountId}`,
        method: 'GET',
        headers: {
          'Authorization': `Basic ${Buffer.from(accountId + ':').toString('base64')}`,
          'Accept': 'application/json'
        },
        // Use basic auth instead of certificates for Teller Connect users
        rejectUnauthorized: true
      };

      const tellerReq = https.request(options, (tellerRes) => {
        let responseBody = '';

        tellerRes.on('data', (chunk) => {
          responseBody += chunk;
        });

        tellerRes.on('end', () => {
          try {
            if (tellerRes.statusCode !== 200) {
              console.error('Teller API error:', tellerRes.statusCode, responseBody);
              throw new Error(`Teller API returned ${tellerRes.statusCode}`);
            }

            const accountDetails = JSON.parse(responseBody);
            console.log('🏦 Account details from Teller:', accountDetails);

            // Update stored account with real institution name
            if (connectedAccounts.has(accountId)) {
              const account = connectedAccounts.get(accountId);
              account.institutionName = accountDetails.institution?.name || 'Unknown Bank';
              account.accountName = accountDetails.name || 'Checking Account';
              account.accountType = accountDetails.type || 'checking';
              connectedAccounts.set(accountId, account);
              console.log(`Updated account: ${accountDetails.institution?.name}`);
            }

            res.setHeader('Content-Type', 'application/json');
            res.writeHead(200);
            res.end(JSON.stringify({
              success: true,
              account: accountDetails
            }));
          } catch (error) {
            console.error('Error parsing Teller response:', error);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Failed to parse account data' }));
          }
        });
      });

      tellerReq.on('error', (error) => {
        console.error('Teller API request error:', error);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to fetch account details' }));
      });

      tellerReq.end();

    } catch (error) {
      console.error('Get account details error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to get account details' }));
    }
  });
}

function handleUpdateTransactionCategory(req, res) {
  if (!isAuthenticated(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', () => {
    try {
      const { transactionId, category, assignedMonth } = JSON.parse(body);

      if (!transactionId || !category) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Transaction ID and category required' }));
        return;
      }

      // Valid categories
      const validCategories = ['Income', 'Out & About', 'Grocery', 'Gas', 'Auto', 'Clothing', 'Gifts', 'Health & Care', 'Home', 'Travel', 'Treats', 'Personal Nick', 'Personal Chelsea', 'School', 'Giving', 'Auto Loan', 'Rent', 'Electric', 'Insurance Auto', 'Insurance - Rent', 'NW Mutual', 'Internet', 'Spotify', 'SP Fitness', 'Alamo Drafthouse', 'Phone', 'Costco', 'Letterboxd', 'Grammarly', 'Domain', 'Google One', 'C - Capital One Annual Fee', 'C - SW Annual Fee', 'N - Capital One Annual Fee', 'N - SW Annual Fee', 'N - Chase Sapphire Annual Fee', 'Ignore', 'Unsorted'];
      if (!validCategories.includes(category)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid category' }));
        return;
      }

      // Update the transaction
      if (transactions.has(transactionId)) {
        const transaction = transactions.get(transactionId);
        transaction.category = category;
        if (assignedMonth) {
          transaction.assignedMonth = assignedMonth;
        }
        transactions.set(transactionId, transaction);

        console.log(`📝 Updated transaction ${transactionId} category to ${category}${assignedMonth ? ` (assigned to ${assignedMonth})` : ''}`);

        // Update in PostgreSQL database
        if (pool) {
          if (assignedMonth) {
            pool.query(
              'UPDATE transactions SET category = $1, assigned_month = $2 WHERE id = $3',
              [category, assignedMonth, transactionId]
            ).catch(dbError => console.error('Failed to update transaction in database:', dbError));
          } else {
            pool.query(
              'UPDATE transactions SET category = $1 WHERE id = $2',
              [category, transactionId]
            ).catch(dbError => console.error('Failed to update transaction in database:', dbError));
          }
        }

        // Save to file as backup
        saveTransactions(transactions);

        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, transaction }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Transaction not found' }));
      }
    } catch (error) {
      console.error('Update category error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to update category' }));
    }
  });
}

function handleUpdateTransactionDate(req, res) {
  if (!isAuthenticated(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', () => {
    try {
      const { transactionId, date, originalDate } = JSON.parse(body);

      if (!transactionId || !date) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Transaction ID and date required' }));
        return;
      }

      if (transactions.has(transactionId)) {
        const transaction = transactions.get(transactionId);
        // Preserve the original date if not already set
        if (!transaction.originalDate && originalDate) {
          transaction.originalDate = originalDate;
        }
        transaction.date = date;
        transactions.set(transactionId, transaction);

        console.log(`📅 Updated transaction ${transactionId} date to ${date} (original: ${transaction.originalDate})`);

        // Update in PostgreSQL database
        if (pool) {
          pool.query(
            'UPDATE transactions SET date = $1, original_date = COALESCE(original_date, $2) WHERE id = $3',
            [date, originalDate, transactionId]
          ).catch(dbError => console.error('Failed to update transaction date in database:', dbError));
        }

        // Save to file as backup
        saveTransactions(transactions);

        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, transaction }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Transaction not found' }));
      }
    } catch (error) {
      console.error('Update date error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to update date' }));
    }
  });
}

function handleUpdateTransactionAmount(req, res) {
  if (!isAuthenticated(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', () => {
    try {
      const { transactionId, amount } = JSON.parse(body);

      if (!transactionId || amount === undefined) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Transaction ID and amount required' }));
        return;
      }

      if (transactions.has(transactionId)) {
        const transaction = transactions.get(transactionId);
        transaction.amount = amount;
        transactions.set(transactionId, transaction);

        console.log(`💰 Updated transaction ${transactionId} amount to ${amount}`);

        // Update in PostgreSQL database
        if (pool) {
          pool.query(
            'UPDATE transactions SET amount = $1 WHERE id = $2',
            [amount, transactionId]
          ).catch(dbError => console.error('Failed to update transaction amount in database:', dbError));
        }

        // Save to file as backup
        saveTransactions(transactions);

        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true, transaction }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Transaction not found' }));
      }
    } catch (error) {
      console.error('Update amount error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to update amount' }));
    }
  });
}

function handleDeleteTransaction(req, res) {
  if (!isAuthenticated(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', () => {
    try {
      const { transactionId } = JSON.parse(body);

      if (!transactionId) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Transaction ID required' }));
        return;
      }

      if (transactions.has(transactionId)) {
        transactions.delete(transactionId);

        console.log(`🗑️ Deleted transaction ${transactionId}`);

        // Delete from PostgreSQL database
        if (pool) {
          pool.query(
            'DELETE FROM transactions WHERE id = $1',
            [transactionId]
          ).catch(dbError => console.error('Failed to delete transaction from database:', dbError));
        }

        // Save to file as backup
        saveTransactions(transactions);

        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({ success: true }));
      } else {
        res.writeHead(404);
        res.end(JSON.stringify({ error: 'Transaction not found' }));
      }
    } catch (error) {
      console.error('Delete transaction error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to delete transaction' }));
    }
  });
}

// Create a manual transaction
function handleCreateManualTransaction(req, res) {
  if (!isAuthenticated(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', async () => {
    try {
      const { description, amount, date, category, bank } = JSON.parse(body);

      if (!description || amount === undefined || !date) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Description, amount, and date are required' }));
        return;
      }

      const transactionId = 'manual_' + Date.now();
      const transaction = {
        id: transactionId,
        accountId: 'manual',
        description: description,
        amount: parseFloat(amount),
        date: date,
        status: 'posted',
        category: category || 'Unsorted',
        bank: bank || 'Manual Entry',
        createdAt: new Date().toISOString()
      };

      // Save to in-memory Map
      transactions.set(transactionId, transaction);

      // Save to PostgreSQL database
      if (pool) {
        try {
          await pool.query(
            `INSERT INTO transactions (id, account_id, description, amount, date, status, category, bank, created_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
            [transactionId, 'manual', description, amount, date, 'posted', category || 'Unsorted', bank || 'Manual Entry', new Date()]
          );
          console.log(`✅ Manual transaction saved to database: ${transactionId}`);
        } catch (dbError) {
          console.error('Failed to save manual transaction to database:', dbError);
          // Remove from memory if database save failed
          transactions.delete(transactionId);
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Failed to save transaction to database' }));
          return;
        }
      }

      // Save to JSON file for persistence (backup)
      saveTransactions(transactions);

      console.log(`✅ Created manual transaction: ${transactionId}`);

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ success: true, transaction }));
    } catch (error) {
      console.error('Create manual transaction error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to create transaction' }));
    }
  });
}

// Get budget for a category/month (with inheritance from previous month)
function handleGetBudget(req, res) {
  if (!isAuthenticated(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', async () => {
    try {
      const { category, month } = JSON.parse(body);

      if (!category || !month) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Category and month required' }));
        return;
      }

      if (!pool) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Database not available' }));
        return;
      }

      // First try to get budget for the exact month
      let result = await pool.query(
        'SELECT amount FROM budgets WHERE category = $1 AND month = $2',
        [category, month]
      );

      if (result.rows.length > 0) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({
          amount: parseFloat(result.rows[0].amount),
          inherited: false,
          month: month
        }));
        return;
      }

      // If no budget for this month, find the most recent previous budget
      result = await pool.query(
        'SELECT amount, month FROM budgets WHERE category = $1 AND month < $2 ORDER BY month DESC LIMIT 1',
        [category, month]
      );

      if (result.rows.length > 0) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(200);
        res.end(JSON.stringify({
          amount: parseFloat(result.rows[0].amount),
          inherited: true,
          inheritedFrom: result.rows[0].month
        }));
        return;
      }

      // No budget found at all
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ amount: null, inherited: false }));

    } catch (error) {
      console.error('Get budget error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to get budget' }));
    }
  });
}

// Save budget for a category/month
function handleSaveBudget(req, res) {
  if (!isAuthenticated(req)) {
    res.writeHead(401);
    res.end(JSON.stringify({ error: 'Unauthorized' }));
    return;
  }

  let body = '';
  req.on('data', chunk => {
    body += chunk.toString();
  });
  req.on('end', async () => {
    try {
      const { category, month, amount } = JSON.parse(body);

      if (!category || !month || amount === undefined) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Category, month, and amount required' }));
        return;
      }

      if (!pool) {
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Database not available' }));
        return;
      }

      // Upsert the budget
      await pool.query(`
        INSERT INTO budgets (category, month, amount, updated_at)
        VALUES ($1, $2, $3, NOW())
        ON CONFLICT (category, month)
        DO UPDATE SET amount = $3, updated_at = NOW()
      `, [category, month, amount]);

      console.log(`💰 Saved budget for ${category} (${month}): $${amount}`);

      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({ success: true }));

    } catch (error) {
      console.error('Save budget error:', error);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to save budget' }));
    }
  });
}

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Budget App running on port ${PORT}`);
  console.log(`📱 Password: ${PASSWORD}`);
  console.log(`💡 Open your browser and visit the URL above`);
  console.log(`🔄 Deployment timestamp: ${new Date().toISOString()}`);
  console.log(`📱 For mobile testing, use: http://192.168.1.187:${PORT}`);

  // Start auto-sync scheduler
  startAutoSync();
});

// Auto-sync configuration
const AUTO_SYNC_INTERVAL = 12 * 60 * 60 * 1000; // 12 hours in milliseconds
let isAutoSyncing = false; // Lock to prevent concurrent syncs

async function autoSyncTransactions() {
  // Prevent concurrent syncs
  if (isAutoSyncing) {
    console.log('⏳ Auto-sync already in progress, skipping...');
    return;
  }

  isAutoSyncing = true;
  console.log(`\n🔄 AUTO-SYNC STARTED at ${new Date().toISOString()}`);

  try {
    // Get all connected accounts (not disconnected, not placeholders)
    const accountsToSync = Array.from(connectedAccounts.values())
      .filter(acc => acc.status !== 'disconnected')
      .filter(acc => acc.lastFour && acc.lastFour !== '****' && acc.lastFour !== '');

    if (accountsToSync.length === 0) {
      console.log('📭 No connected accounts to sync');
      isAutoSyncing = false;
      return;
    }

    console.log(`📋 Found ${accountsToSync.length} accounts to sync`);

    // Group accounts by enrollment token to avoid duplicate API calls
    const enrollmentTokens = [...new Set(accountsToSync.map(acc => acc.enrollmentToken))];
    console.log(`🔑 ${enrollmentTokens.length} unique enrollment(s) to process`);

    let totalNewTransactions = 0;

    for (const enrollmentToken of enrollmentTokens) {
      try {
        const result = await syncEnrollment(enrollmentToken);
        totalNewTransactions += result.newCount || 0;
        console.log(`  ✅ Enrollment synced: ${result.newCount} new transactions`);
      } catch (error) {
        console.error(`  ❌ Failed to sync enrollment: ${error.message}`);
      }
    }

    console.log(`🎉 AUTO-SYNC COMPLETE: ${totalNewTransactions} new transactions`);

  } catch (error) {
    console.error('❌ Auto-sync error:', error);
  } finally {
    isAutoSyncing = false;
  }
}

// Sync a single enrollment (reusable function)
async function syncEnrollment(enrollmentToken) {
  return new Promise(async (resolve, reject) => {
    try {
      const https = require('https');

      let cert, key;
      try {
        cert = fs.readFileSync('./certificate.pem');
        key = fs.readFileSync('./private_key.pem');
      } catch (error) {
        if (process.env.TELLER_CERT_B64 && process.env.TELLER_KEY_B64) {
          cert = Buffer.from(process.env.TELLER_CERT_B64, 'base64');
          key = Buffer.from(process.env.TELLER_KEY_B64, 'base64');
        } else {
          throw new Error('Certificate files not found');
        }
      }

      const options = {
        hostname: 'api.teller.io',
        path: '/accounts',
        method: 'GET',
        headers: {
          'Authorization': `Basic ${Buffer.from(enrollmentToken + ':').toString('base64')}`,
          'Accept': 'application/json'
        },
        cert: cert,
        key: key,
        rejectUnauthorized: false
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', async () => {
          if (res.statusCode === 403 || res.statusCode === 401) {
            // Mark accounts with this enrollment as disconnected
            connectedAccounts.forEach((acc, id) => {
              if (acc.enrollmentToken === enrollmentToken) {
                acc.status = 'disconnected';
                if (pool) {
                  pool.query('UPDATE accounts SET status = $1 WHERE id = $2', ['disconnected', id]).catch(() => {});
                }
              }
            });
            resolve({ newCount: 0, error: 'disconnected' });
            return;
          }

          if (res.statusCode !== 200) {
            resolve({ newCount: 0, error: `API error ${res.statusCode}` });
            return;
          }

          const accounts = JSON.parse(body);

          // Get existing transaction IDs from database
          let existingTxnIds = new Set();
          if (pool) {
            try {
              const existing = await pool.query('SELECT id FROM transactions');
              existing.rows.forEach(row => existingTxnIds.add(row.id));
            } catch (e) {}
          }

          let newCount = 0;

          // Fetch transactions for each account
          for (const acc of accounts) {
            try {
              const txns = await fetchAccountTransactions(acc.id, enrollmentToken, cert, key);
              for (const txn of txns) {
                // Skip pending transactions
                if (txn.status === 'pending') continue;

                const isNew = !existingTxnIds.has(txn.id);
                if (isNew) newCount++;

                const existingCategory = transactions.has(txn.id)
                  ? transactions.get(txn.id).category
                  : 'Unsorted';

                // BofA sends correct signs, other banks send positive - negate non-BofA only
                const isBofA = acc.institution?.name?.toLowerCase().includes('bank of america');
                const finalAmount = isBofA ? parseFloat(txn.amount) : -parseFloat(txn.amount);

                const transaction = {
                  id: txn.id,
                  accountId: acc.id,
                  description: txn.description,
                  amount: finalAmount,
                  date: txn.date,
                  status: txn.status,
                  category: existingCategory,
                  createdAt: new Date().toISOString()
                };

                transactions.set(txn.id, transaction);

                if (pool && isNew) {
                  pool.query(
                    `INSERT INTO transactions (id, account_id, description, amount, date, status, category, created_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                     ON CONFLICT (id) DO NOTHING`,
                    [txn.id, acc.id, txn.description, finalAmount, txn.date, txn.status, 'Unsorted', new Date()]
                  ).catch(() => {});
                }
              }
            } catch (e) {
              console.error(`    Error fetching transactions for ${acc.name}: ${e.message}`);
            }
          }

          resolve({ newCount });
        });
      });

      req.on('error', (error) => reject(error));
      req.end();

    } catch (error) {
      reject(error);
    }
  });
}

// Fetch transactions for a single account
function fetchAccountTransactions(accountId, enrollmentToken, cert, key) {
  return new Promise((resolve, reject) => {
    const https = require('https');

    const options = {
      hostname: 'api.teller.io',
      path: `/accounts/${accountId}/transactions?from_date=2026-01-01`,
      method: 'GET',
      headers: {
        'Authorization': `Basic ${Buffer.from(enrollmentToken + ':').toString('base64')}`,
        'Accept': 'application/json'
      },
      cert: cert,
      key: key,
      rejectUnauthorized: false
    };

    const req = https.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        if (res.statusCode === 200) {
          resolve(JSON.parse(body));
        } else {
          resolve([]); // Return empty on error
        }
      });
    });

    req.on('error', () => resolve([]));
    req.end();
  });
}

function startAutoSync() {
  console.log(`⏰ Auto-sync enabled: every 12 hours`);

  // Run first sync after 1 minute (let server fully initialize)
  setTimeout(() => {
    console.log('🔄 Running initial auto-sync...');
    autoSyncTransactions();
  }, 60 * 1000);

  // Then run every 12 hours
  setInterval(() => {
    autoSyncTransactions();
  }, AUTO_SYNC_INTERVAL);
}

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});