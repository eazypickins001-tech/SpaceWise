// Thin shell: the finding itself lives in dupfind.ts so it can be tested.
import { parentPort, workerData } from "worker_threads";
import { findDuplicates } from "./dupfind";
import type { DupCandidate } from "../shared/types";

const groups = findDuplicates(workerData as DupCandidate[], {
  onProgress: (progress) => parentPort!.postMessage({ type: "progress", progress }),
});

parentPort!.postMessage({ type: "done", groups });
