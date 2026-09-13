import { readFileSync } from "node:fs";
import { evaluateOutcomes, type Outcome } from "./calibration.js";

const [file, cutoff] = process.argv.slice(2);
if (!file || !cutoff) throw new Error("Usage: ratings:evaluate verified-outcomes.json cutoff-unix-seconds");
const input: unknown = JSON.parse(readFileSync(file, "utf8"));
if (!Array.isArray(input) || input.length > 100_000) throw new Error("Expected at most 100,000 independently verified outcome rows");
console.log(JSON.stringify(evaluateOutcomes(input as Outcome[], Number(cutoff)), null, 2));
