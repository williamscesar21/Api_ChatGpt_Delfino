// services/workerPool.js
import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';

const POOL_SIZE = Number(process.env.WORKER_POOL_SIZE || 2);
const workers   = [];
const queue     = [];

const workerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../workers/parseWorker.js'
);

// Crea el pool
for (let i = 0; i < POOL_SIZE; i++) {
  workers.push(makeWorker());
}

function makeWorker() {
  const w = new Worker(workerPath);
  w.busy = false;
  return w;
}

/**
 * Ejecuta una tarea en el primer worker libre;
 * si todos están ocupados se encola.
 * @param {object} data  { filePath, ext }
 * @returns {Promise<any>}
 */
export function runInWorker(data) {
  return new Promise((resolve, reject) => {
    const task = { data, resolve, reject };
    const w = workers.find(w => !w.busy);
    if (w) exec(w, task);
    else   queue.push(task);
  });
}

function exec(worker, task) {
  worker.busy = true;
  worker.once('message', msg => {
    worker.busy = false;
    // atiende la cola
    if (queue.length) exec(worker, queue.shift());

    msg.ok ? task.resolve(msg.content)
           : task.reject(new Error(msg.error));
  });
  worker.postMessage(task.data);
}
