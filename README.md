# Enhanced Limitless MCP Integration

This repository provides an enhanced MCP server/client implementation for interacting with the Limitless Developer API (GET endpoint only). It includes SQLite caching, 7-day data retention, and improved error handling.

## Features

- **MCP Server**: Exposes a GET endpoint:
  - `getLifelogs`: List lifelogs with optional query parameters.
- **SQLite Caching**: 
  - Local storage of lifelog entries
  - 7-day data retention
  - Automatic cleanup of old entries
- **Enhanced Error Handling**:
  - Robust API error management
  - Database operation error handling
  - Detailed error logging
- **MCP Client**: Connects to the server and calls the tools.
- **Interactive Mode**: Allows calling any tool with JSON parameters.
- Passes environment variables (including API key) to the spawned server.

## Prerequisites

- Node.js v20 or higher (with native fetch support or a polyfill)
- npm
- A valid Limitless API key

## Setup

1. **Clone the repository** and navigate into it.
2. **Install dependencies:**

```bash
npm ci
```

3. **Export** your API key:

```sh
export LIMITLESS_API_KEY=your_api_key_here
```

## Build

Compile the TypeScript code:

```bash
npm run build
```

## Usage

The merged implementation supports three modes:

- **Server Mode**: Runs the MCP server.

```bash
node build/index.js server
```

- **Client Mode**: Spawns the server and calls the `getLifelogs` tool.

```bash
node build/index.js client
```

- **Interactive Mode**: Launches an interactive client to call tools with JSON parameters.

```bash
node build/index.js interactive
```

## Data Management

- Lifelog entries are cached locally in SQLite
- Data is retained for 7 days before automatic cleanup
- Cache is updated every 8 minutes
- No size limits on API responses

## References

- [Limitless Developer API Documentation](https://www.limitless.ai/developers/docs/api)
- [Limitless API Examples on GitHub](https://github.com/limitless-ai-inc/limitless-api-examples)

## License

This project is licensed under the MIT License.
