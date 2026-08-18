#!/usr/bin/env node

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DEFAULT_MIN_SSIM = 0.998;
const DEFAULT_MIN_SILHOUETTE_IOU = 0.995;
const DEFAULT_MAX_SILHOUETTE_AREA_DELTA = 0.005;

function projectPath(value) {
  return isAbsolute(value) ? value : resolve(repoRoot, value);
}

function option(name, fallback = null) {
  const index = process.argv.indexOf(name);
  if (index < 0) return fallback;
  const value = process.argv[index + 1];
  if (!value) throw new Error(`${name} requires a value`);
  return value;
}

function hasOption(name) {
  return process.argv.includes(name);
}

function globalSsim(left, right) {
  let leftSum = 0;
  let rightSum = 0;
  let leftSquared = 0;
  let rightSquared = 0;
  let product = 0;
  const pixels = left.width * left.height;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    const leftLuma = 0.2126 * left.data[offset] + 0.7152 * left.data[offset + 1] + 0.0722 * left.data[offset + 2];
    const rightLuma = 0.2126 * right.data[offset] + 0.7152 * right.data[offset + 1] + 0.0722 * right.data[offset + 2];
    leftSum += leftLuma;
    rightSum += rightLuma;
    leftSquared += leftLuma * leftLuma;
    rightSquared += rightLuma * rightLuma;
    product += leftLuma * rightLuma;
  }
  const leftMean = leftSum / pixels;
  const rightMean = rightSum / pixels;
  const leftVariance = leftSquared / pixels - leftMean * leftMean;
  const rightVariance = rightSquared / pixels - rightMean * rightMean;
  const covariance = product / pixels - leftMean * rightMean;
  const c1 = (0.01 * 255) ** 2;
  const c2 = (0.03 * 255) ** 2;
  return (
    ((2 * leftMean * rightMean + c1) * (2 * covariance + c2)) /
    ((leftMean * leftMean + rightMean * rightMean + c1) * (leftVariance + rightVariance + c2))
  );
}

function silhouetteMetrics(left, right, threshold = 30) {
  const leftBackground = [left.data[0], left.data[1], left.data[2]];
  const rightBackground = [right.data[0], right.data[1], right.data[2]];
  const maximumY = Math.floor(left.height * 0.82);
  let intersection = 0;
  let union = 0;
  let leftArea = 0;
  let rightArea = 0;
  for (let y = 0; y < maximumY; y += 1) {
    for (let x = 0; x < left.width; x += 1) {
      const offset = (y * left.width + x) * 4;
      const leftForeground = Math.hypot(
        left.data[offset] - leftBackground[0],
        left.data[offset + 1] - leftBackground[1],
        left.data[offset + 2] - leftBackground[2],
      ) > threshold;
      const rightForeground = Math.hypot(
        right.data[offset] - rightBackground[0],
        right.data[offset + 1] - rightBackground[1],
        right.data[offset + 2] - rightBackground[2],
      ) > threshold;
      if (leftForeground) leftArea += 1;
      if (rightForeground) rightArea += 1;
      if (leftForeground && rightForeground) intersection += 1;
      if (leftForeground || rightForeground) union += 1;
    }
  }
  return {
    threshold,
    iou: union === 0 ? 1 : intersection / union,
    areaDelta: Math.abs(leftArea - rightArea) / Math.max(1, leftArea, rightArea),
    baselinePixels: leftArea,
    candidatePixels: rightArea,
  };
}

function pixelMetrics(left, right) {
  let absoluteError = 0;
  let squaredError = 0;
  let changedPixels = 0;
  const channels = left.width * left.height * 3;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    let changed = false;
    for (let channel = 0; channel < 3; channel += 1) {
      const difference = left.data[offset + channel] - right.data[offset + channel];
      absoluteError += Math.abs(difference);
      squaredError += difference * difference;
      changed ||= difference !== 0;
    }
    if (changed) changedPixels += 1;
  }
  const rmse = Math.sqrt(squaredError / channels);
  return {
    meanAbsoluteError: absoluteError / channels,
    rmse,
    psnrDb: rmse === 0 ? null : 20 * Math.log10(255 / rmse),
    changedPixelFraction: changedPixels / (left.width * left.height),
  };
}

function main() {
  const baselineDir = projectPath(option("--baseline-dir", "public/worldclaw/assets/dossiers"));
  const candidateDir = projectPath(option("--candidate-dir", "/tmp/worldclaw-compact-stage/dossiers"));
  const reportPath = hasOption("--report") ? projectPath(option("--report")) : null;
  const minimumSsim = Number(option("--min-ssim", DEFAULT_MIN_SSIM));
  const minimumSilhouetteIou = Number(option("--min-silhouette-iou", DEFAULT_MIN_SILHOUETTE_IOU));
  const maximumSilhouetteAreaDelta = Number(option("--max-silhouette-area-delta", DEFAULT_MAX_SILHOUETTE_AREA_DELTA));
  const files = readdirSync(baselineDir).filter((name) => name.endsWith(".png")).sort();
  if (files.length === 0) throw new Error(`No baseline PNG files found in ${baselineDir}`);
  const results = [];
  const failures = [];
  for (const name of files) {
    const baselinePath = join(baselineDir, name);
    const candidatePath = join(candidateDir, name);
    if (!existsSync(candidatePath)) {
      failures.push(`${name}: candidate image is missing`);
      continue;
    }
    const baselineBytes = readFileSync(baselinePath);
    const candidateBytes = readFileSync(candidatePath);
    const baseline = PNG.sync.read(baselineBytes);
    const candidate = PNG.sync.read(candidateBytes);
    if (baseline.width !== candidate.width || baseline.height !== candidate.height) {
      failures.push(`${name}: dimensions differ (${baseline.width}x${baseline.height} vs ${candidate.width}x${candidate.height})`);
      continue;
    }
    const ssim = globalSsim(baseline, candidate);
    const silhouette = name.endsWith("-turnaround.png") ? silhouetteMetrics(baseline, candidate) : null;
    const metrics = pixelMetrics(baseline, candidate);
    const result = {
      name,
      width: baseline.width,
      height: baseline.height,
      baselineSha256: createHash("sha256").update(baselineBytes).digest("hex"),
      candidateSha256: createHash("sha256").update(candidateBytes).digest("hex"),
      ssim,
      ...metrics,
      ...(silhouette ? { silhouette } : {}),
    };
    results.push(result);
    if (ssim < minimumSsim) failures.push(`${name}: SSIM ${ssim.toFixed(6)} is below ${minimumSsim}`);
    if (silhouette?.iou < minimumSilhouetteIou) failures.push(`${name}: silhouette IoU ${silhouette.iou.toFixed(6)} is below ${minimumSilhouetteIou}`);
    if (silhouette?.areaDelta > maximumSilhouetteAreaDelta) failures.push(`${name}: silhouette area delta ${silhouette.areaDelta.toFixed(6)} exceeds ${maximumSilhouetteAreaDelta}`);
  }
  const report = {
    version: 1,
    policy: "exported_glb_roundtrip_global_ssim_and_upper_frame_silhouette_v1",
    baselineDir: relative(repoRoot, baselineDir),
    candidateDir: relative(repoRoot, candidateDir),
    thresholds: { minimumSsim, minimumSilhouetteIou, maximumSilhouetteAreaDelta },
    summary: {
      expectedFileCount: files.length,
      comparedFileCount: results.length,
      minimumSsim: Math.min(...results.map((item) => item.ssim)),
      minimumSilhouetteIou: Math.min(...results.filter((item) => item.silhouette).map((item) => item.silhouette.iou)),
      maximumSilhouetteAreaDelta: Math.max(...results.filter((item) => item.silhouette).map((item) => item.silhouette.areaDelta)),
      failures,
    },
    files: results,
  };
  if (reportPath) {
    mkdirSync(dirname(reportPath), { recursive: true });
    writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
  }
  if (failures.length) throw new Error(`WorldClaw dossier parity failed:\n- ${failures.join("\n- ")}`);
  console.log(
    `WORLDCLAW_DOSSIER_PARITY_OK files=${results.length} ` +
    `minSsim=${report.summary.minimumSsim.toFixed(6)} ` +
    `minSilhouetteIou=${report.summary.minimumSilhouetteIou.toFixed(6)} ` +
    `maxSilhouetteAreaDelta=${report.summary.maximumSilhouetteAreaDelta.toFixed(6)}`,
  );
}

main();
