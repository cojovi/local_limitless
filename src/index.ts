import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport as ServerStdioTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { z } from 'zod';
import { fileURLToPath } from 'url';
import readline from 'readline/promises';
import sqlite3 from 'sqlite3';
import { promisify } from 'util';
import fs from 'fs';
import path from 'path';

const LIMITLESS_API_BASE = 'https://api.limitless.ai';
const LIMITLESS_API_KEY = process.env.LIMITLESS_API_KEY;
if (!LIMITLESS_API_KEY) {
  console.error('Missing LIMITLESS_API_KEY in environment variables');
  process.exit(1);
}

// Ensure data directory exists
const dataDir = path.join(process.cwd(), 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// Initialize SQLite database
const db = new sqlite3.Database(path.join(dataDir, 'lifelogs_cache.db'));
const dbRun = (sql: string, params?: any[]): Promise<void> => {
  return new Promise((resolve, reject) => {
    db.run(sql, params, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
};
const dbAll = (sql: string, params?: any[]): Promise<{ data: string }[]> => {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
      if (err) reject(err);
      else resolve(rows as { data: string }[]);
    });
  });
};

// Create tables and indexes if they don't exist
async function initializeDatabase() {
  // Create lifelogs table if it doesn't exist
  await dbRun(`
    CREATE TABLE IF NOT EXISTS lifelogs (
      id TEXT PRIMARY KEY,
      startTime TEXT,
      data TEXT
    )
  `);

  // Create index on startTime if it doesn't exist
  await dbRun(`
    CREATE INDEX IF NOT EXISTS idx_lifelogs_time ON lifelogs(startTime)
  `);

  // Create last_pull table if it doesn't exist
  await dbRun(`
    CREATE TABLE IF NOT EXISTS last_pull (
      id INTEGER PRIMARY KEY,
      last_pull_time TEXT,
      last_cursor TEXT,
      last_error TEXT,
      last_error_time TEXT
    )
  `);

  // Insert initial record if none exists
  await dbRun(`
    INSERT OR IGNORE INTO last_pull (id, last_pull_time, last_cursor)
    VALUES (1, datetime('now'), NULL)
  `);
}

/**
 * Helper function to perform HTTP GET requests using fetch.
 * It appends query parameters if provided.
 */
async function makeLimitlessRequest<T>(url: string, params?: Record<string, unknown>): Promise<T> {
  if (!LIMITLESS_API_KEY) {
    throw new Error('Missing LIMITLESS_API_KEY in environment variables');
  }

  const headers = {
    'Accept': '*/*',
    'User-Agent': 'curl/8.5.0',
    'X-API-Key': LIMITLESS_API_KEY
  } as const;

  // Convert params to URLSearchParams
  const queryParams = new URLSearchParams();
  if (params) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        queryParams.append(key, String(value));
      }
    });
  }

  // Append query parameters to URL if any exist
  const fullUrl = `${url}${queryParams.toString() ? `?${queryParams.toString()}` : ''}`;
  
  const response = await fetch(fullUrl, { 
    method: 'GET', 
    headers,
    // Ensure no size limits on the response
    signal: AbortSignal.timeout(30000) // 30 second timeout
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Request failed: ${response.status} ${errorText}`);
  }
  
  // Read the response as text first to ensure we get the complete response
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch (e: unknown) {
    const errorMessage = e instanceof Error ? e.message : 'Unknown error';
    throw new Error(`Failed to parse API response: ${errorMessage}`);
  }
}

/* =================== SERVER CODE (GET endpoints only) =================== */

// Schema for GET /v1/lifelogs query parameters
const getLifelogsSchema = {
  timezone: z.string().optional(),
  date: z.string().optional(),
  start: z.string().optional(),
  end: z.string().optional(),
  cursor: z.string().optional(),
  direction: z.enum(['asc', 'desc']).optional().default('desc'),
  includeMarkdown: z.boolean().optional().default(true),
  includeHeadings: z.boolean().optional().default(true),
  limit: z.number().optional(),
};

// Function to get the last successful pull time and cursor
async function getLastPullInfo() {
  const rows = await dbAll('SELECT last_pull_time, last_cursor FROM last_pull WHERE id = 1') as unknown as { last_pull_time: string, last_cursor: string }[];
  return rows[0] || { last_pull_time: null, last_cursor: null };
}

// Function to update the last pull information
async function updateLastPullInfo(cursor: string | null = null) {
  await dbRun(
    'UPDATE last_pull SET last_pull_time = datetime("now"), last_cursor = ? WHERE id = 1',
    [cursor]
  );
}

// Function to log errors
async function logError(error: string) {
  await dbRun(
    'UPDATE last_pull SET last_error = ?, last_error_time = datetime("now") WHERE id = 1',
    [error]
  );
}

// Function to fetch new lifelogs from the API
async function fetchNewLifelogs(lastPullTime: string | null, lastCursor: string | null) {
  if (!LIMITLESS_API_KEY) {
    throw new Error('Missing LIMITLESS_API_KEY in environment variables');
  }

  try {
    const params: Record<string, unknown> = {
      timezone: 'UTC',
      includeMarkdown: true,
      includeHeadings: true,
      direction: 'desc'
    };
    
    if (lastPullTime) {
      params.start = lastPullTime;
    }
    if (lastCursor) {
      params.cursor = lastCursor;
    }

    const data = await makeLimitlessRequest<any>(`${LIMITLESS_API_BASE}/v1/lifelogs`, params);
    return data;
  } catch (error) {
    console.error('Error fetching lifelogs:', error);
    await logError(error instanceof Error ? error.message : 'Unknown error');
    throw error;
  }
}

// Function to perform the update check
async function performUpdateCheck() {
  try {
    const { last_pull_time, last_cursor } = await getLastPullInfo();
    console.log(`Starting update check. Last pull: ${last_pull_time}, Last cursor: ${last_cursor}`);

    const data = await fetchNewLifelogs(last_pull_time, last_cursor);
    
    if (data.data?.lifelogs && data.data.lifelogs.length > 0) {
      for (const lifelog of data.data.lifelogs) {
        await dbRun(
          'INSERT OR IGNORE INTO lifelogs (id, startTime, data) VALUES (?, ?, ?)',
          [lifelog.id, lifelog.startTime, JSON.stringify(lifelog)]
        );
      }
      console.log(`Stored ${data.data.lifelogs.length} new lifelogs`);
    }

    // Update last pull info with the new cursor
    await updateLastPullInfo(data.meta?.lifelogs?.nextCursor || null);
    console.log('Update check completed successfully');
  } catch (error) {
    console.error('Update check failed:', error);
    throw error;
  }
}

// Function to start the periodic update check
function startPeriodicUpdateCheck() {
  const EIGHT_MINUTES = 8 * 60 * 1000; // 8 minutes in milliseconds
  
  // Perform initial check
  performUpdateCheck().catch(error => {
    console.error('Initial update check failed:', error);
  });

  // Set up periodic check
  setInterval(() => {
    performUpdateCheck().catch(error => {
      console.error('Periodic update check failed:', error);
    });
  }, EIGHT_MINUTES);
}

async function runServer() {
  // Initialize SQLite database
  await initializeDatabase();

  // Start background cleanup process
  setInterval(async () => {
    try {
      await dbRun('DELETE FROM lifelogs WHERE startTime < datetime("now", "-7 days")');
      console.log('Cleaned up old lifelog entries');
    } catch (error) {
      console.error('Error cleaning up old entries:', error);
    }
  }, 60 * 60 * 1000); // Run every hour

  // Start the periodic update check
  startPeriodicUpdateCheck();

  const server = new McpServer({
    name: 'Limitless Lifelog Server',
    version: '1.0.0',
  });

  // Tool: getLifelogs
  server.tool('getLifelogs', 'Retrieve a list of lifelogs.', getLifelogsSchema, async (params) => {
    try {
      // Determine the requested time range from params
      const { date, start, end, limit, direction = 'desc' } = params;
      let rangeStart: string | undefined;
      let rangeEnd: string | undefined;
      if (date) {
        // If a date is specified (YYYY-MM-DD), use that day's range
        rangeStart = `${date} 00:00:00`;
        rangeEnd = `${date} 23:59:59`;
      }
      if (start) rangeStart = start;
      if (end) rangeEnd = end;

      // Build SQL query based on the range
      let sql = `SELECT data FROM lifelogs`;
      const conditions: string[] = [];
      const paramsArr: string[] = [];
      if (rangeStart) { conditions.push(`startTime >= ?`); paramsArr.push(rangeStart); }
      if (rangeEnd) { conditions.push(`startTime <= ?`); paramsArr.push(rangeEnd); }
      if (conditions.length) {
        sql += ` WHERE ` + conditions.join(' AND ');
      }
      sql += ` ORDER BY startTime ${direction === 'asc' ? 'ASC' : 'DESC'}`;
      if (limit) {
        sql += ` LIMIT ?`;
        paramsArr.push(limit.toString());
      }

      // Query the SQLite cache for matching entries
      const rows = await dbAll(sql, paramsArr);

      if (rows.length > 0) {
        // Cache hit: format the data similar to the API response
        const cachedEntries = rows.map(r => JSON.parse(r.data));
        const responseObj = {
          data: { lifelogs: cachedEntries },
          meta: { 
            lifelogs: { count: cachedEntries.length, nextCursor: null } 
          }
        };
        return { content: [{ type: 'text', text: JSON.stringify(responseObj, null, 2) }] };
      }

      // Cache miss: fetch from API
      const lifelogs = await makeLimitlessRequest<any>(`${LIMITLESS_API_BASE}/v1/lifelogs`, params);
      
      // Store fetched lifelogs in the SQLite cache
      if (lifelogs.data && lifelogs.data.lifelogs) {
        for (const entry of lifelogs.data.lifelogs) {
          const entryId = entry.id;
          const entryTime = entry.startTime;
          const entryJson = JSON.stringify(entry);
          // Insert entry into cache (use OR IGNORE to avoid duplicates)
          await dbRun(
            `INSERT OR IGNORE INTO lifelogs (id, startTime, data) VALUES (?, ?, ?)`,
            [entryId, entryTime, entryJson]
          );
        }
      }

      // Purge cache of entries older than 72 hours
      const cutoff = new Date(Date.now() - 72 * 3600 * 1000).toISOString().slice(0,19);
      await dbRun(`DELETE FROM lifelogs WHERE startTime < ?`, [cutoff]);

      return { content: [{ type: 'text', text: JSON.stringify(lifelogs, null, 2) }] };
    } catch (error: any) {
      return { content: [{ type: 'text', text: `Error fetching lifelogs: ${error.message}` }], isError: true };
    }
  });

  const transport = new ServerStdioTransport();
  await server.connect(transport);
  console.error('MCP Server running on stdio');

  // Handle graceful shutdown
  process.on('SIGINT', () => {
    console.log('Closing database...');
    db.close((err) => {
      if (err) {
        console.error('Error closing database:', err);
      }
      process.exit(0);
    });
  });
}

/* =================== CLIENT CODE =================== */

async function runClient() {
  const __filename = fileURLToPath(import.meta.url);
  const client = new Client({ name: 'lifelog-client', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [__filename, 'server'],
    env: { LIMITLESS_API_KEY: `${LIMITLESS_API_KEY}` },
  });
  await client.connect(transport);
  const toolsResponse = await client.listTools();
  console.log(
    'Connected. Available tools:',
    toolsResponse.tools.map((tool) => tool.name)
  );

  try {
    // Call the "getLifelogs" tool with no parameters.
    const response = await client.callTool({
      name: 'getLifelogs',
      arguments: {},
    });
    console.log('Response from getLifelogs:', JSON.stringify(response, null, 2));
  } catch (error: any) {
    console.error('Error:', error.message);
  }
  await client.close();
}

async function runInteractiveClient() {
  const __filename = fileURLToPath(import.meta.url);
  const client = new Client({ name: 'lifelog-client', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [__filename, 'server'],
    env: { LIMITLESS_API_KEY: `${LIMITLESS_API_KEY}` },
  });
  await client.connect(transport);
  const toolsResponse = await client.listTools();
  console.log(
    'Connected. Available tools:',
    toolsResponse.tools.map((t) => t.name)
  );
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    while (true) {
      const toolName = await rl.question("Enter tool name (or 'quit'): ");
      if (toolName.toLowerCase() === 'quit') break;
      const paramsInput = await rl.question('Enter JSON parameters (or {}): ');
      let params = {};
      try {
        params = JSON.parse(paramsInput || '{}');
      } catch (e) {
        console.error('Invalid JSON. Try again.');
        continue;
      }
      try {
        const response = await client.callTool({ name: toolName, arguments: params });
        console.log('Response:', JSON.stringify(response, null, 2));
      } catch (error: any) {
        console.error('Error:', error.message);
      }
    }
  } finally {
    rl.close();
  }
  await client.close();
}

/* =================== MODE SELECTION =================== */

const mode = process.argv[2];
if (mode === 'server') {
  runServer().catch((err) => {
    console.error('Server error:', err);
    process.exit(1);
  });
} else if (mode === 'client') {
  runClient().catch((err) => {
    console.error('Client error:', err);
    process.exit(1);
  });
} else if (mode === 'interactive') {
  runInteractiveClient().catch((err) => {
    console.error('Interactive client error:', err);
    process.exit(1);
  });
} else {
  console.error('Usage: node build/index.js [server|client|interactive]');
  process.exit(1);
}
