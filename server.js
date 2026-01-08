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
        connected_at TIMESTAMP DEFAULT NOW()
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS transactions (
        id TEXT PRIMARY KEY,
        account_id TEXT,
        description TEXT,
        amount DECIMAL,
        date TEXT,
        status TEXT,
        category TEXT,
        created_at TIMESTAMP DEFAULT NOW(),
        FOREIGN KEY(account_id) REFERENCES accounts(id)
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
        status: row.status,
        category: row.category,
        createdAt: row.created_at
      });
    });
    console.log(`📊 Loaded ${transactions.size} transactions from PostgreSQL`);

  } catch (error) {
    console.error('Failed to load from database:', error);
    console.log('Starting with fresh data');
  }
}

// Initialize and load data on startup
(async () => {
  if (pool) {
    console.log('🔄 Initializing PostgreSQL database...');
    await initializeDatabase();
    await loadFromDatabase();
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

// Load sessions from file
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

// Save sessions to file
function saveSessions(sessions) {
  try {
    const sessionData = Object.fromEntries(sessions);
    fs.writeFileSync(sessionFile, JSON.stringify(sessionData, null, 2));
  } catch (error) {
    console.error('Error saving sessions:', error);
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
  } else if (pathname === '/api/accounts' && req.method === 'GET') {
    handleGetAccounts(req, res);
  } else if (pathname === '/api/account/details' && req.method === 'POST') {
    handleGetAccountDetails(req, res);
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
  req.on('end', () => {
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

        res.setHeader('Set-Cookie', `sessionId=${sessionId}; HttpOnly; Path=/; Max-Age=${90 * 24 * 60 * 60}; SameSite=Strict`);
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

function handleLogout(req, res) {
  const cookies = parseCookies(req.headers.cookie || '');
  const sessionId = cookies.sessionId;
  if (sessionId) {
    sessions.delete(sessionId);
    saveSessions(sessions);
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

      // The enrollment token IS the account - store it directly
      // Store the connected account directly using enrollment data
      const accountData = {
        id: enrollmentToken,
        enrollmentToken: enrollmentToken,
        institutionName: institutionName,
        accountName: 'Account',
        accountType: 'depository',
        subtype: 'checking',
        lastFour: '****',
        connectedAt: new Date().toISOString()
      };

      connectedAccounts.set(enrollmentToken, accountData);
      console.log(`✅ Stored account: ${institutionName} - Account`);

      // Save to PostgreSQL database
      if (pool) {
        try {
          console.log('💾 Saving account to PostgreSQL:', { enrollmentToken, institutionName });
          const result = await pool.query(
            `INSERT INTO accounts (id, enrollment_token, institution_name, account_name, account_type, subtype, last_four, connected_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT (id) DO UPDATE SET
               enrollment_token = $2,
               institution_name = $3,
               account_name = $4,
               account_type = $5,
               subtype = $6,
               last_four = $7,
               connected_at = $8
             RETURNING *`,
            [enrollmentToken, enrollmentToken, institutionName, 'Account', 'depository', 'checking', '****', new Date()]
          );
          console.log('✅ Account saved to PostgreSQL successfully:', result.rowCount, 'row(s) affected');
        } catch (dbError) {
          console.error('❌ CRITICAL: Failed to save account to database:', dbError.message);
          console.error('Database error details:', dbError);
        }
      } else {
        console.log('⚠️ No database pool available - account only saved to file storage');
      }

      // Save accounts to file as backup
      saveAccounts(connectedAccounts);

      // Return success with the account data
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        message: `Connected 1 account`,
        accounts: [accountData]
      }));

      // Use only enrollment data - no API calls needed

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
    'Miscellaneous': { keywords: ['misc', 'other'], emoji: '🧩', color: '#a4b0be' },
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

              // Load from existing local file storage where real transactions exist
              const allTransactions = Array.from(transactions.values())
                .filter(t => t.date && t.date.startsWith('2026-01'))
                .filter(t => t.id.startsWith('txn_')); // Real Teller transaction IDs

              console.log('📊 Loading existing real transactions from memory:', allTransactions.length);

              res.setHeader('Content-Type', 'application/json');
              res.writeHead(200);
              res.end(JSON.stringify({
                success: true,
                message: `Loaded ${allTransactions.length} existing transactions`,
                transactions: allTransactions,
                count: allTransactions.length
              }));
              return;
            }

            const accounts = JSON.parse(accountsBody);
            console.log('📋 Found accounts:', accounts.length);

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

            // STEP 2: Get transactions from first account
            const firstAccount = accounts[0];
            console.log('💳 Getting transactions for account:', firstAccount.id);

            const transactionsOptions = {
              hostname: 'api.teller.io',
              path: `/accounts/${firstAccount.id}/transactions?from_date=2026-01-01`,
              method: 'GET',
              headers: {
                'Authorization': `Basic ${Buffer.from(enrollmentToken + ':').toString('base64')}`,
                'Accept': 'application/json'
              },
              cert: cert,
              key: key,
              rejectUnauthorized: false
            };

            const transactionsReq = https.request(transactionsOptions, (transactionsRes) => {
              let transactionsBody = '';

              transactionsRes.on('data', (chunk) => {
                transactionsBody += chunk;
              });

              transactionsRes.on('end', async () => {
                try {
                  if (transactionsRes.statusCode !== 200) {
                    console.error('❌ Teller transactions API error:', transactionsRes.statusCode, transactionsBody);
                    res.writeHead(500);
                    res.end(JSON.stringify({
                      error: `Teller transactions API error: ${transactionsRes.statusCode}`,
                      details: transactionsBody
                    }));
                    return;
                  }

                  const tellerTransactions = JSON.parse(transactionsBody);
                  console.log('🎉 Successfully fetched transactions from Teller:', tellerTransactions.length);

                  // Process and save transactions
                  const processedTransactions = tellerTransactions.map(txn => {
                    const transaction = {
                      id: txn.id,
                      accountId: accountId,
                      description: txn.description,
                      amount: -Math.abs(txn.amount),
                      date: txn.date,
                      status: txn.status,
                      category: 'Unsorted',
                      createdAt: new Date().toISOString()
                    };

                    transactions.set(txn.id, transaction);

                    // Save to PostgreSQL
                    if (pool) {
                      pool.query(
                        `INSERT INTO transactions (id, account_id, description, amount, date, status, category, created_at)
                         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
                         ON CONFLICT (id) DO NOTHING`,
                        [txn.id, accountId, txn.description, -Math.abs(txn.amount), txn.date, txn.status, 'Unsorted', new Date()]
                      ).catch(dbError => console.error('Failed to save transaction:', dbError));
                    }

                    return transaction;
                  });

                  res.setHeader('Content-Type', 'application/json');
                  res.writeHead(200);
                  res.end(JSON.stringify({
                    success: true,
                    transactions: processedTransactions,
                    count: processedTransactions.length
                  }));

                } catch (error) {
                  console.error('Error parsing transactions response:', error);
                  res.writeHead(500);
                  res.end(JSON.stringify({ error: 'Failed to parse transactions' }));
                }
              });
            });

            transactionsReq.on('error', (error) => {
              console.error('Transactions API request error:', error);
              res.writeHead(500);
              res.end(JSON.stringify({ error: 'Failed to fetch transactions' }));
            });

            transactionsReq.end();

          } catch (error) {
            console.error('Error parsing accounts response:', error);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Failed to parse accounts data' }));
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
    const allTransactions = Array.from(transactions.values()).sort((a, b) =>
      new Date(b.date) - new Date(a.date)
    );

    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ transactions: allTransactions }));
  } catch (error) {
    console.error('Get transactions error:', error);
    res.writeHead(500);
    res.end(JSON.stringify({ error: 'Failed to get transactions' }));
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
      const { transactionId, category } = JSON.parse(body);

      if (!transactionId || !category) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Transaction ID and category required' }));
        return;
      }

      // Valid categories
      const validCategories = ['Income', 'Out & About', 'Grocery', 'Gas', 'Auto', 'Clothing', 'Gifts', 'Health & Care', 'Home', 'Travel', 'Treats', 'Personal Nick', 'Personal Chelsea', 'School', 'Miscellaneous', 'Giving', 'Auto Loan', 'Rent', 'Electric', 'Insurance Auto', 'NW Mutual', 'Internet', 'Spotify', 'SP Fitness', 'Alamo Drafthouse', 'Phone', 'Costco', 'Unsorted'];
      if (!validCategories.includes(category)) {
        res.writeHead(400);
        res.end(JSON.stringify({ error: 'Invalid category' }));
        return;
      }

      // Update the transaction
      if (transactions.has(transactionId)) {
        const transaction = transactions.get(transactionId);
        transaction.category = category;
        transactions.set(transactionId, transaction);

        console.log(`📝 Updated transaction ${transactionId} category to ${category}`);

        // Update in PostgreSQL database
        if (pool) {
          pool.query(
            'UPDATE transactions SET category = $1 WHERE id = $2',
            [category, transactionId]
          ).catch(dbError => console.error('Failed to update transaction in database:', dbError));
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

server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Budget App running on port ${PORT}`);
  console.log(`📱 Password: ${PASSWORD}`);
  console.log(`💡 Open your browser and visit the URL above`);
  console.log(`🔄 Deployment timestamp: ${new Date().toISOString()}`);
  console.log(`📱 For mobile testing, use: http://192.168.1.187:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n👋 Shutting down server...');
  server.close(() => {
    console.log('✅ Server closed');
    process.exit(0);
  });
});