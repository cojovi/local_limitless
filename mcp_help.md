Adding Automatic SQLite Caching for Lifelog Data in Limitless MCP Server
Introduction: In this guide, we will modify the Limitless MCP Server (the Node.js server from the GitHub repo manueltarouca/limitless-mcp-server) to cache lifelog entries in a local SQLite database. Currently, the server calls the Limitless API’s /v1/lifelogs endpoint directly for each request. We’ll introduce a caching layer so that recent lifelog data (within the last 72 hours) is stored locally. Future requests can then retrieve data from the SQLite cache, reducing external API calls. We will also implement automatic pruning of entries older than 72 hours to prevent the cache from growing indefinitely. This guide assumes you are comfortable with Node.js and basic SQL.
Prerequisites and Setup
Clone and Install Dependencies: Ensure you have the project set up with Node.js v20+. If you haven’t already, clone the repository and install dependencies:
bash
Copy
git clone https://github.com/manueltarouca/limitless-mcp-server.git 
cd limitless-mcp-server 
npm ci
Also make sure you have a valid Limitless API key exported as LIMITLESS_API_KEY in your environment (as described in the repository README).
Add SQLite3 Dependency: We will use SQLite for local storage. Install the SQLite3 Node.js package:
bash
Copy
npm install sqlite3
This will download the SQLite3 library, which includes the SQLite engine. (No separate database server is required – SQLite uses a file on disk​
SQLITETUTORIAL.NET
.) If you are using TypeScript, you may also want to install type definitions: npm install --save-dev @types/sqlite3.
Prepare the Database: SQLite will store data in a file. We can create a new database file (e.g., lifelogs_cache.db) in the project directory. The SQLite3 package’s Database class will create the file if it doesn’t exist​
SQLITETUTORIAL.NET
. We will create a table to hold lifelog entries, with columns for the entry ID, its timestamp, and the data payload. We’ll also add an index on the timestamp for efficient time-range queries. All of this will be done in code when the server starts, so no manual SQL setup is needed.
Modifying the Server Code for Caching
Open the project’s source file src/index.ts in your editor. We will make changes primarily inside the runServer() function, which defines the getLifelogs tool logic. Below are the steps and code changes required:
Import and Initialize SQLite: At the top of the file (with the other imports), import the SQLite3 module and initialize a database connection when the server starts. For example:
ts
Copy
import sqlite3 from 'sqlite3';
Inside the runServer() function, before defining any tools, open (or create) the database and ensure the cache table exists:
ts
Copy
// Inside runServer(), before server.tool definitions:
const db = new sqlite3.Database('./lifelogs_cache.db');  
db.run(`CREATE TABLE IF NOT EXISTS lifelogs (
    id TEXT PRIMARY KEY, 
    startTime TEXT, 
    data TEXT
)`);
db.run(`CREATE INDEX IF NOT EXISTS idx_lifelogs_time ON lifelogs(startTime)`);
This code opens (or creates) a file lifelogs_cache.db and then creates a table lifelogs if it doesn’t already exist​
SITEPOINT.COM
. The table has an id column (text, primary key) for the lifelog’s unique ID, a startTime column to record when the entry started, and a data column to store the full JSON of the entry. We also create an index on startTime to speed up range queries by timestamp.
Check Cache Before API Call: Next, modify the getLifelogs tool handler to query this SQLite cache before calling the external API. In the server.tool('getLifelogs', ...) definition, add logic at the start of the async function to check if the requested lifelogs are already in the database. For example:
ts
Copy
server.tool('getLifelogs', 'Retrieve a list of lifelogs.', getLifelogsSchema, async (params) => {
    try {
        // Determine the requested time range from params
        const { date, start, end, limit, direction = 'desc' } = params;
        let rangeStart: string | undefined;
        let rangeEnd: string | undefined;
        if (date) {
            // If a date is specified (YYYY-MM-DD), use that day's range
            rangeStart = `${date} 00:00:00`;
            rangeEnd   = `${date} 23:59:59`;
        }
        if (start) rangeStart = start;
        if (end)   rangeEnd   = end;
        // Build SQL query based on the range
        let sql = `SELECT data FROM lifelogs`;
        const conditions: string[] = [];
        const paramsArr: string[] = [];
        if (rangeStart) { conditions.push(`startTime >= ?`); paramsArr.push(rangeStart); }
        if (rangeEnd)   { conditions.push(`startTime <= ?`); paramsArr.push(rangeEnd); }
        if (conditions.length) {
            sql += ` WHERE ` + conditions.join(' AND ');
        }
        // Apply sorting and limit to match requested params
        sql += ` ORDER BY startTime ${direction === 'asc' ? 'ASC' : 'DESC'}`;
        if (limit) {
            sql += ` LIMIT ?`;
            paramsArr.push(limit.toString());
        }
        // Query the SQLite cache for matching entries
        const rows: { data: string }[] = await new Promise((resolve, reject) => {
            db.all(sql, paramsArr, (err, rows) => {
                if (err) reject(err);
                else resolve(rows || []);
            });
        });
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
        // If cache miss, proceed to fetch from API...
        …
Let’s break down what this does: First, we extract any time range parameters (date, start, end) from the request. We compute a rangeStart and rangeEnd string based on these. For example, if date is provided, we assume the range is that whole day (from midnight to 23:59:59 of that date). If start and/or end are provided, we use those directly. We then construct an SQL query to select cached lifelogs whose startTime falls within the requested range. We use parameter binding (?) to safely insert the values into the query. We also sort the results according to the requested direction (ascending or descending) and respect the limit if one was provided, so that the cached result mirrors what the API would return. This query is executed with db.all(...) to retrieve all matching rows. If any rows are found, we parse the JSON stored in each row’s data field, reconstruct an object in the same format as the API’s response (a data object containing a list of lifelogs, plus a meta with count), and return that as the tool’s result. At this point, the cached data is returned to the client without ever calling the external API. Note: The effectiveness of this cache check depends on having the relevant data in the cache. If new lifelog entries have appeared since the last API fetch (especially for open-ended queries like “most recent entries”), the cache might be outdated. In this simple implementation, we assume that if an entry is in the cache, it is acceptable to return – updates will eventually be fetched on a cache miss. For critical real-time data (e.g. the very latest entries), you might choose to always fetch anew or implement a short cache expiration. Here we focus on caching to reduce duplicate API calls in a short span and for historical ranges.
Fetch from the Limitless API (Cache Miss): If the cache query returns no rows (cache miss), we fall back to fetching from the Limitless API as originally designed. The existing code uses makeLimitlessRequest to call the API. We will keep that, but afterward we’ll add steps to store the result in the cache. For example, continuing the code above:
ts
Copy
        // ... inside getLifelogs handler, cache miss case ...
        const lifelogs = await makeLimitlessRequest<any>(`${LIMITLESS_API_BASE}/v1/lifelogs`, params);
        // Store fetched lifelogs in the SQLite cache
        if (lifelogs.data && lifelogs.data.lifelogs) {
            for (const entry of lifelogs.data.lifelogs) {
                const entryId = entry.id;
                const entryTime = entry.startTime;
                const entryJson = JSON.stringify(entry);
                // Insert entry into cache (use OR IGNORE to avoid duplicates)
                db.run(
                    `INSERT OR IGNORE INTO lifelogs (id, startTime, data) VALUES (?, ?, ?)`,
                    [entryId, entryTime, entryJson],
                    err => { if (err) console.error('DB insert error:', err); }
                );
            }
        }
        // Purge cache of entries older than 72 hours
        const cutoff = new Date(Date.now() - 72 * 3600 * 1000).toISOString().slice(0,19); // current time minus 72h (ISO format up to seconds)
        db.run(`DELETE FROM lifelogs WHERE startTime < ?`, [cutoff]);
        // Return the freshly fetched data as response
        return { content: [{ type: 'text', text: JSON.stringify(lifelogs, null, 2) }] };
    } catch (error: any) {
        return { content: [{ type: 'text', text: `Error fetching lifelogs: ${error.message}` }], isError: true };
    }
});
In this snippet, after fetching lifelogs from the API, we iterate over each entry in the response (lifelogs.data.lifelogs array). Each entry is inserted into the SQLite table. We use INSERT OR IGNORE to avoid duplicating an entry that might already exist in the cache. (This SQLite syntax will quietly skip inserting if the primary key (entry ID) already exists​
HOELZ.RO
.) We store the id, the startTime (as a text timestamp), and the entire entry JSON in the data column. Next, we perform the 72-hour cleanup: we calculate a cutoff timestamp 72 hours prior to now, and issue a DELETE query to remove all cached entries older than that cutoff. This ensures that the cache only retains roughly the last 3 days of lifelogs. (We use startTime for this comparison. If you prefer to base it on the entry’s end time or another metric, adjust accordingly. The key is that any entry with a start time older than 72 hours ago is purged.) Finally, we return the API response in the same format as before so the client gets the data. The rest of the error handling (catch block) remains unchanged, returning an error message if the API request fails.
(Optional) Background Cleanup: In the above implementation, old entries are purged during each new API fetch. This is simple and ensures the cache stays trim. However, you may also implement a background job to clean old entries periodically, which can decouple cleanup from user requests. For example, you could use setInterval inside runServer() to run a cleanup query every hour:
ts
Copy
// After setting up db and before defining tools:
setInterval(() => {
    const cutoff = new Date(Date.now() - 72 * 3600 * 1000).toISOString().slice(0,19);
    db.run(`DELETE FROM lifelogs WHERE startTime < ?`, [cutoff]);
}, 60 * 60 * 1000);
This will quietly delete expired records every 60 minutes in the background. Either approach (on-demand or interval) is fine; choose based on your performance needs. For a low-traffic server, doing it during requests is okay. For a high-traffic scenario, a periodic task might be better to avoid adding latency to user requests.
Close DB on Shutdown (Best Practice): SQLite writes data to disk, so it’s good practice to close the database when your server shuts down to ensure all data is flushed. You can do this by listening for process exit signals (like SIGINT) and calling db.close(). For example:
ts
Copy
process.on('SIGINT', () => {
    console.log('Closing database...');
    db.close();
    process.exit(0);
});
This isn’t strictly required (Node will usually clean up, and our writes are mostly immediate), but it mirrors good practice shown in many examples (open, then close the database when done)​
SQLITETUTORIAL.NET
.
With these changes, the server will now cache lifelog responses locally. Make sure to rebuild the project (npm run build) if needed, since we edited the TypeScript source, and then restart the server.
Verification and Usage
After implementing the above changes, test the modified server to ensure it behaves as expected:
Run the MCP Server: Start the server in “server mode” as usual (e.g., node build/index.js server). The server should initialize the SQLite database. You might see the database file lifelogs_cache.db appear in your project directory after the first write. No errors should be printed on startup (if there is an issue connecting to SQLite, check that the sqlite3 package installed correctly).
Test a Lifelog Request: You can use the client mode or interactive mode provided by the project to call getLifelogs. For example, run node build/index.js client which by default calls getLifelogs with no parameters. The first call will fetch from the Limitless API (make sure your LIMITLESS_API_KEY is set) and you should see the output JSON of lifelogs. Now run the same command again; this time, the server should retrieve the data from the SQLite cache. From the client perspective the output will look the same. To confirm the caching, you could add a temporary console.log in the cache-hit path or check the SQLite DB content manually (e.g., by opening lifelogs_cache.db with the sqlite3 command-line tool and running SELECT COUNT(*) FROM lifelogs; to see that entries have been stored).
Test with Query Parameters: Try querying a specific date or range via the interactive mode. For example, in interactive mode (node build/index.js interactive), you can enter the tool name getLifelogs and then JSON parameters, e.g.:
json
Copy
{ "date": "2025-03-28", "timezone": "UTC" }
This should return all lifelogs from March 28, 2025 (in UTC). The first time will hit the API and cache the results. If you run the same query again, it should be served from cache (nearly instantly, with no external API call). If you query a different date or a range not in cache, it will fetch and then store those. The cache will keep at most the last 72 hours of data – you can test that by querying an older date, which will fetch (and then shortly be purged if outside the 72h window).
Best Practices and Maintenance
Data Model: We used the lifelog entry’s unique id as the primary key in the cache (as provided by the API​
RAW.GITHUBUSERCONTENT.COM
). This ensures we don’t store duplicate entries. The startTime is used for querying and cleanup. All data for an entry is stored as a JSON string in the data column for simplicity. This works well for our caching scenario. If you needed to query by other fields, you could add columns (e.g., for title or endTime), but that’s not necessary for basic caching.
Thread Safety: The Node SQLite3 library is asynchronous and can handle concurrent queries. We perform inserts and deletes in a loop here, which is fine for moderate volumes. If you anticipate a large number of entries or very frequent calls, consider wrapping multiple inserts in a transaction or using a prepared statement for batch inserts to improve performance. Given the Limitless API’s maximum page size (10 entries) and our 72-hour retention, the data volume is limited, so this approach is sufficient.
Cache Invalidation: We implemented a time-based eviction (72 hours). This is a straightforward policy assuming that lifelog data older than 3 days is not needed frequently. If your use case requires a different retention period, simply adjust the cutoff calculation (e.g., 24 hours or 7 days). For data freshness, as noted, new lifelog entries within the cached range won’t appear until an API fetch occurs (cache miss triggers it). If real-time updates are critical, you might reduce the cache duration or always bypass cache for queries that include the current date. Another strategy is to update existing cache entries if an API fetch returns an entry that’s already cached (to catch any edits), but if lifelogs are append-only, this may not be necessary.
Database File Location: We placed the SQLite database in the current directory for convenience. In a production setting, you might store this in a dedicated data folder or specify the path via an environment variable. Ensure the Node process has write permissions to the location. The SQLite file can safely be added to your .gitignore to avoid committing cache data to source control.
Monitoring and Backup: The cache is meant to be ephemeral (only recent data), so regular backups are not critical. However, you should monitor the size of the lifelogs_cache.db file over time. With the 72-hour purge in place, it should remain bounded. If the device running the server has limited disk space, verify that the retention policy is working. You can periodically VACUUM the SQLite database to compact it after deletions, though for such a small scale this is usually not needed.
By following this guide, you have added a caching layer to the Limitless MCP Server that will save recent lifelog entries in a local SQLite database. This improves efficiency by avoiding repeated calls to the Limitless API for the same data and provides quick access to recent lifelogs. The solution is self-contained (no external cache service needed) and automatically maintains itself by purging old records. With proper maintenance and consideration for data freshness, this caching mechanism should greatly benefit scenarios where lifelog data is requested frequently within short time spans. Enjoy your enhanced MCP server with SQLite caching!





Sources
