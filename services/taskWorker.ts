import fs from 'fs';
import path from 'path';
import axios from 'axios';
import dotenv from 'dotenv';

dotenv.config({ path: path.resolve(process.cwd(), '../.env.global') });

const QUEUE_FILE = path.join(process.cwd(), 'TASK_QUEUE.json');
const BACKEND_URL = process.env.BACKEND_CORE_URL || 'http://localhost:8000';
const AXIOS_TIMEOUT_MS = Number(process.env.WORKER_AXIOS_TIMEOUT_MS || 120000);
const MAX_HISTORY = Number(process.env.WORKER_MAX_HISTORY || 100);

interface BackendTask {
  id: string;
  type: 'separate-stems' | 'generate-voice' | 'apply-fx' | 'render';
  payload: any;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  createdAt?: number;
  processedAt?: number;
  result?: any;
  error?: string;
}

function readQueue(): { tasks: BackendTask[] } {
  if (!fs.existsSync(QUEUE_FILE)) return { tasks: [] };
  try {
    const parsed = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
    return { tasks: Array.isArray(parsed?.tasks) ? parsed.tasks : [] };
  } catch {
    console.warn('Worker: TASK_QUEUE.json unlesbar – starte mit leerer Queue.');
    return { tasks: [] };
  }
}

function writeQueue(data: { tasks: BackendTask[] }) {
  // History begrenzen, damit die Datei nicht unbegrenzt wächst.
  if (data.tasks.length > MAX_HISTORY) {
    data.tasks = data.tasks.slice(-MAX_HISTORY);
  }
  fs.writeFileSync(QUEUE_FILE, JSON.stringify(data, null, 2));
}

async function processTasks() {
  const data = readQueue();

  // Nächsten offenen Task suchen (kein shift → Status bleibt erhalten).
  const task = data.tasks.find((t) => t.status === 'pending');
  if (!task) return;

  task.status = 'processing';
  writeQueue(data);
  console.log('Worker: Verarbeite', task.type, '-', task.id);

  try {
    let response;
    switch (task.type) {
      case 'separate-stems':
        response = await axios.post(`${BACKEND_URL}/api/separate-stems`, task.payload, { timeout: AXIOS_TIMEOUT_MS });
        break;
      case 'generate-voice':
        response = await axios.post(`${BACKEND_URL}/api/generate-voice`, task.payload, { timeout: AXIOS_TIMEOUT_MS });
        break;
      case 'apply-fx':
        response = await axios.post(`${BACKEND_URL}/api/apply-fx`, task.payload, { timeout: AXIOS_TIMEOUT_MS });
        break;
      case 'render':
        response = await axios.post(`${BACKEND_URL}/api/render`, task.payload, { timeout: AXIOS_TIMEOUT_MS });
        break;
      default:
        throw new Error(`Unbekannter Task-Typ: ${task.type}`);
    }

    task.status = 'completed';
    task.processedAt = Date.now();
    task.result = response.data;
    console.log('Worker: Fertig', task.type, '-', task.id);
  } catch (error) {
    task.status = 'failed';
    task.processedAt = Date.now();
    task.error = error instanceof Error ? error.message : String(error);
    console.error('Worker: Fehler bei', task.type, '-', task.id, ':', task.error);
  }

  writeQueue(data);
}

// Poll alle 10 Sekunden (kein Überlappen: erst nach Abschluss erneut).
setInterval(() => {
  processTasks().catch((e) => console.error('Worker: Poll-Fehler', e));
}, 10000);
console.log('Worker: Gestartet – pollt TASK_QUEUE.json (10s-Intervall).');
