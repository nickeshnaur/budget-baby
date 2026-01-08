const http = require('http');
const fs = require('fs');
const path = require('path');
const url = require('url');
const querystring = require('querystring');
const sqlite3 = require('sqlite3').verbose();

const PORT = process.env.PORT || 3000;
const PASSWORD = 'babywolfdog';

// Teller.io configuration
const TELLER_CONFIG = {
    applicationId: 'app_pn2qum0p0bom9ppvn0000',
    publicKey: 'cXLqnm451Bi1sMtKTPWOwdFz3gMtNYPn2hVkgXxy9gc=',
    environment: 'development' // Now with client certificates for real bank data
};

// Database setup
const dbPath = path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH || '.', 'budget.db');
console.log(`📁 Database path: ${dbPath}`);
console.log(`📁 Volume mount path: ${process.env.RAILWAY_VOLUME_MOUNT_PATH || 'not set'}`);
const db = new sqlite3.Database(dbPath, (err) => {
  if (err) {
    console.error('❌ Failed to open database:', err);
  } else {
    console.log(`✅ Database connected: ${dbPath}`);
  }
});

// Initialize database tables
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    enrollment_token TEXT,
    institution_name TEXT,
    account_name TEXT,
    account_type TEXT,
    subtype TEXT,
    last_four TEXT,
    connected_at TEXT
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS transactions (
    id TEXT PRIMARY KEY,
    account_id TEXT,
    description TEXT,
    amount REAL,
    date TEXT,
    status TEXT,
    category TEXT,
    created_at TEXT,
    FOREIGN KEY(account_id) REFERENCES accounts(id)
  )`);
});

// In-memory storage for quick access
const connectedAccounts = new Map();
const transactions = new Map();

// Load data from environment variables as backup
function loadFromEnvironment() {
  try {
    if (process.env.CONNECTED_ACCOUNTS) {
      const accountsData = JSON.parse(process.env.CONNECTED_ACCOUNTS);
      Object.entries(accountsData).forEach(([key, value]) => {
        connectedAccounts.set(key, value);
      });
      console.log(`🏦 Loaded ${connectedAccounts.size} accounts from environment`);
    }

    if (process.env.TRANSACTIONS_DATA) {
      const transactionsData = JSON.parse(process.env.TRANSACTIONS_DATA);
      Object.entries(transactionsData).forEach(([key, value]) => {
        transactions.set(key, value);
      });
      console.log(`📊 Loaded ${transactions.size} transactions from environment`);
    }
  } catch (error) {
    console.log('No environment data found, starting fresh');
  }
}

// Load data from database on startup
function loadFromDatabase() {
  // Load accounts
  db.all(`SELECT * FROM accounts`, (err, rows) => {
    if (err) {
      console.error('Failed to load accounts from database:', err);
      loadFromEnvironment();
      return;
    }
    rows.forEach(row => {
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
    console.log(`🏦 Loaded ${connectedAccounts.size} connected accounts from database`);

    // Fallback to environment if database is empty
    if (connectedAccounts.size === 0) {
      loadFromEnvironment();
    }
  });

  // Load transactions
  db.all(`SELECT * FROM transactions`, (err, rows) => {
    if (err) {
      console.error('Failed to load transactions from database:', err);
      return;
    }
    rows.forEach(row => {
      transactions.set(row.id, {
        id: row.id,
        accountId: row.account_id,
        description: row.description,
        amount: row.amount,
        date: row.date,
        status: row.status,
        category: row.category,
        createdAt: row.created_at
      });
    });
    console.log(`📊 Loaded ${transactions.size} transactions from database`);
  });
}

// Initialize database and load data
setTimeout(() => {
  loadFromDatabase();
}, 100);

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

// Load connected accounts at startup
const savedAccounts = loadAccounts();
savedAccounts.forEach((account, id) => {
  connectedAccounts.set(id, account);
});
console.log(`🏦 Loaded ${connectedAccounts.size} connected accounts`);

// Load transactions at startup
const savedTransactions = loadTransactions();
savedTransactions.forEach((transaction, id) => {
  transactions.set(id, transaction);
});
console.log(`📊 Loaded ${transactions.size} transactions`);

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

function handleTellerAccount(req, res) {
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

      // Save accounts to persistent storage
      saveAccounts(connectedAccounts);

      // Return success with the account data
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({
        success: true,
        message: `Connected 1 account`,
        accounts: [accountData]
      }));

      // Skip the Teller API call for now and use direct enrollment data
      return;

      // Fetch actual accounts using enrollment token
      const https = require('https');
      const options = {
        hostname: 'api.teller.io',
        path: '/accounts',
        method: 'GET',
        headers: {
          'Authorization': `Basic ${Buffer.from(enrollmentToken + ':').toString('base64')}`,
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

            const accounts = JSON.parse(responseBody);
            console.log('🏦 Real accounts from Teller:');
            console.log(JSON.stringify(accounts, null, 2));

            // Store each account with real data in database
            accounts.forEach(account => {
              const accountData = {
                id: account.id,
                enrollmentToken: enrollmentToken,
                institutionName: account.institution?.name || 'Unknown Bank',
                accountName: account.name || `${account.subtype || account.type || 'Account'}`,
                accountType: account.type,
                subtype: account.subtype,
                lastFour: account.last_four || 'N/A',
                connectedAt: new Date().toISOString()
              };

              // Save to database
              db.run(`INSERT OR REPLACE INTO accounts
                     (id, enrollment_token, institution_name, account_name, account_type, subtype, last_four, connected_at)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                     [account.id, enrollmentToken, accountData.institutionName, accountData.accountName,
                      accountData.accountType, accountData.subtype, accountData.lastFour, accountData.connectedAt]);

              // Also store in memory for quick access
              connectedAccounts.set(account.id, accountData);
              console.log(`✅ Stored account: ${accountData.institutionName} - ${accountData.accountName} ****${accountData.lastFour}`);

              // Save to environment variables as backup
              const accountsBackup = Object.fromEntries(connectedAccounts);
              process.env.CONNECTED_ACCOUNTS = JSON.stringify(accountsBackup);
            });

            res.setHeader('Content-Type', 'application/json');
            res.writeHead(200);
            res.end(JSON.stringify({
              success: true,
              message: `Connected ${accounts.length} account(s)`,
              accounts: accounts
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
        res.end(JSON.stringify({ error: 'Failed to fetch accounts from bank' }));
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

      // Fetch real transactions from Teller API with proper filtering for 2026+
      console.log(`🔍 Fetching real transactions for account ${accountId} (2026+ only)`);

      // First, get the real account data from Teller using enrollment token
      const httpsModule = require('https');

      // Step 1: Get the actual account ID using enrollment token
      const accountOptions = {
        hostname: 'api.teller.io',
        path: '/accounts',
        method: 'GET',
        headers: {
          'Authorization': `Basic ${Buffer.from(enrollmentToken + ':').toString('base64')}`,
          'Accept': 'application/json'
        },
        // Use basic auth instead of certificates for Teller Connect users
        rejectUnauthorized: true
      };

      const accountReq = httpsModule.request(accountOptions, (accountRes) => {
        let accountResponseBody = '';

        accountRes.on('data', (chunk) => {
          accountResponseBody += chunk;
        });

        accountRes.on('end', () => {
          try {
            if (accountRes.statusCode !== 200) {
              console.error('Teller Account API error:', accountRes.statusCode, accountResponseBody);
              res.writeHead(500);
              res.end(JSON.stringify({ error: 'Failed to fetch account details from bank' }));
              return;
            }

            const accounts = JSON.parse(accountResponseBody);
            console.log('🏦 Real accounts found:', accounts.length);

            if (accounts.length === 0) {
              res.writeHead(200);
              res.end(JSON.stringify({ success: true, transactions: [], count: 0 }));
              return;
            }

            // Use the first account (for simplicity)
            const realAccount = accounts[0];
            console.log(`📋 Using account: ${realAccount.id} from ${realAccount.institution?.name}`);

            // Step 2: Fetch transactions using the real account ID
            const fromDate = '2026-01-01'; // Get transactions from 2026 onwards
            const txnOptions = {
              hostname: 'api.teller.io',
              path: `/accounts/${realAccount.id}/transactions?from_date=${fromDate}`,
              method: 'GET',
              headers: {
                'Authorization': `Basic ${Buffer.from(enrollmentToken + ':').toString('base64')}`,
                'Accept': 'application/json'
              },
              cert: fs.readFileSync('./certificate.pem'),
              key: fs.readFileSync('./private_key.pem'),
              rejectUnauthorized: true
            };

            const txnReq = httpsModule.request(txnOptions, (txnRes) => {
              let txnResponseBody = '';

              txnRes.on('data', (chunk) => {
                txnResponseBody += chunk;
              });

              txnRes.on('end', () => {
                try {
                  if (txnRes.statusCode !== 200) {
                    console.error('Teller Transaction API error:', txnRes.statusCode, txnResponseBody);
                    res.writeHead(500);
                    res.end(JSON.stringify({ error: 'Failed to fetch transactions from bank' }));
                    return;
                  }

                  const tellerTransactions = JSON.parse(txnResponseBody);
                  console.log('💳 Real transactions from Teller:', tellerTransactions.length);

                  // Filter for 2026+ and keep all as UNSORTED
                  const filteredTransactions = tellerTransactions.filter(txn => {
                    const txnDate = new Date(txn.date);
                    const txnYear = txnDate.getFullYear();
                    return txnYear >= 2026;
                  });

                  console.log(`📅 Filtered to ${filteredTransactions.length} transactions from 2026+`);

                  const unsortedTransactions = filteredTransactions.map(txn => {
                    // All new transactions are UNSORTED by default
                    const transaction = {
                      id: txn.id,
                      accountId: accountId,
                      description: txn.description,
                      amount: -Math.abs(txn.amount), // Assume all unsorted transactions are expenses (negative)
                      date: txn.date,
                      status: txn.status,
                      category: 'Unsorted', // Always unsorted initially
                      createdAt: new Date().toISOString()
                    };

                    // Save to database
                    db.run(`INSERT OR REPLACE INTO transactions
                           (id, account_id, description, amount, date, status, category, created_at)
                           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                           [transaction.id, transaction.accountId, transaction.description, transaction.amount,
                            transaction.date, transaction.status, transaction.category, transaction.createdAt]);

                    transactions.set(txn.id, transaction);
                    return transaction;
                  });

                  console.log(`📊 Successfully synced ${unsortedTransactions.length} REAL UNSORTED transactions from Dec 2025+`);
                  saveTransactions(transactions);

                  res.setHeader('Content-Type', 'application/json');
                  res.writeHead(200);
                  res.end(JSON.stringify({
                    success: true,
                    transactions: unsortedTransactions,
                    count: unsortedTransactions.length
                  }));

                } catch (error) {
                  console.error('Error parsing Teller transaction response:', error);
                  res.writeHead(500);
                  res.end(JSON.stringify({ error: 'Failed to parse transaction data' }));
                }
              });
            });

            txnReq.on('error', (error) => {
              console.error('Teller Transaction API request error:', error);
              res.writeHead(500);
              res.end(JSON.stringify({ error: 'Failed to fetch transactions from bank' }));
            });

            txnReq.end();

          } catch (error) {
            console.error('Error parsing Teller account response:', error);
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Failed to parse account data' }));
          }
        });
      });

      accountReq.on('error', (error) => {
        console.error('Teller Account API request error:', error);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to fetch account details from bank' }));
      });

      accountReq.end();
      return;
      // Fetch real transactions from Teller API
      try {
        const https = require('https');

        const options = {
          hostname: 'api.teller.io',
          path: `/accounts/${enrollmentToken}/transactions`,
          method: 'GET',
          headers: {
            'Authorization': `Basic ${Buffer.from(enrollmentToken + ':').toString('base64')}`,
            'Accept': 'application/json'
          },
          cert: fs.readFileSync('./certificate.pem'),
          key: fs.readFileSync('./private_key.pem'),
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

              const tellerTransactions = JSON.parse(responseBody);
              console.log('🏦 Real transactions from Teller:', tellerTransactions.length);

              // Categorize and store real transactions
              const categorizedTransactions = tellerTransactions.map(txn => {
                const category = categorizeTransaction(txn.description, Math.abs(txn.amount));
                const transaction = {
                  id: txn.id,
                  accountId: accountId,
                  description: txn.description,
                  amount: category === 'Income' ? Math.abs(txn.amount) : -Math.abs(txn.amount),
                  date: txn.date,
                  status: txn.status,
                  category: category,
                  createdAt: new Date().toISOString()
                };
                transactions.set(txn.id, transaction);
                return transaction;
              });

              console.log(`📊 Fetched ${categorizedTransactions.length} REAL transactions for account ${accountId}`);
              saveTransactions(transactions);

              res.setHeader('Content-Type', 'application/json');
              res.writeHead(200);
              res.end(JSON.stringify({
                success: true,
                transactions: categorizedTransactions,
                count: categorizedTransactions.length
              }));
            } catch (error) {
              console.error('Error parsing Teller response:', error);
              res.writeHead(500);
              res.end(JSON.stringify({ error: 'Failed to parse transaction data' }));
            }
          });
        });

        tellerReq.on('error', (error) => {
          console.error('Teller API request error:', error);
          res.writeHead(500);
          res.end(JSON.stringify({ error: 'Failed to fetch transactions from bank' }));
        });

        tellerReq.end();

      } catch (apiError) {
        console.error('Error calling Teller API:', apiError);
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Failed to fetch transactions from bank' }));
      }
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