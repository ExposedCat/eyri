import { Database } from "@db/sqlite";

const DEFAULT_DATABASE_PATH = "data/eyri.sqlite";

let database: Promise<Database> | null = null;

export function openDatabase(path: string) {
  const connection = new Database(path);
  try {
    // The bot, healthcheck and standalone MCP can all open the same file.
    // Wait for short transactions instead of failing immediately on contention.
    connection.exec("PRAGMA busy_timeout = 5000");
    return connection;
  } catch (error) {
    connection.close();
    throw error;
  }
}

function getDatabasePath() {
  return Deno.env.get("EYRI_DATABASE_PATH") ?? DEFAULT_DATABASE_PATH;
}

function getParentDirectory(path: string) {
  const separatorIndex = path.lastIndexOf("/");
  return separatorIndex === -1 ? "." : path.slice(0, separatorIndex);
}

async function initializeDatabase() {
  const path = getDatabasePath();
  await Deno.mkdir(getParentDirectory(path), { recursive: true });
  return openDatabase(path);
}

export function getDatabase() {
  // Cache initialization too: concurrent callers must not open extra connections.
  return database ??= initializeDatabase().catch((error) => {
    database = null;
    throw error;
  });
}
