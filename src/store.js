import fs from 'fs';
import path from 'path';

const DATA_DIR = path.join(process.cwd(), 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

function ensureStore() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(STORE_FILE)) {
    fs.writeFileSync(STORE_FILE, JSON.stringify({ lastSeenId: 0, initialized: false, pending: {} }, null, 2));
  }
}

export function loadStore() {
  ensureStore();
  return JSON.parse(fs.readFileSync(STORE_FILE, 'utf-8'));
}

export function saveStore(store) {
  ensureStore();
  fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
}
