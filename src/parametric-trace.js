import { skeletonizeMask as skeletonize, buildMaskGraph as buildSkeletonGraph } from "./mask-geometry.js?v=0.20.0-preview.3.21";
import {
  clamp,
  compositedColorDistance,
  inclusionMaskAllows,
  normalizeRect,
} from "./core.js?v=0.20.0-preview.3.21";

const neighborOffsets = [
  [0, -1], [1, -1], [1, 0], [1, 1],
  [0, 1], [-1, 1], [-1, 0], [-1, -1],
];

function pixelExcluded(x, y, exclusions) {
  return exclusions.some((rect) => (
    x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  ));
}

function inclusionAllows(mask, width, x, y) {
  if (mask?.allowed) return inclusionMaskAllows(mask, width, x, y);
  if (!mask?.data || !mask?.columns) return true;
  const column = Math.round(x);
  const row = Math.round(y);
  if (column < 0 || column >= width || row < 0 || row >= mask.data.length / width) return false;
  // A scan-line trace may use a Pen stroke only in selected columns and keep
  // searching normally elsewhere. A two-dimensional path cannot: allowing
  // unpainted columns reconnects the target to axes, labels, or another curve
  // outside the painted route—especially after a hairpin turns vertical.
  // Parametric tracing therefore treats the painted pixels as a true global
  // inclusion corridor. A partial corridor safely yields no complete 2D path
  // and the automatic engine can retain its ordinary scan-line result.
  return Boolean(mask.data[row * width + column]);
}

function buildTargetMask({
  rgba,
  width,
  height,
  rect,
  target,
  threshold,
  exclusions,
  inclusionMask,
  anchors = [],
}) {
  const safeRect = normalizeRect(
    { x: rect.left, y: rect.top },
    { x: rect.right, y: rect.bottom },
    { width, height },
  );
  const localWidth = safeRect.right - safeRect.left + 1;
  const localHeight = safeRect.bottom - safeRect.top + 1;
  const mask = new Uint8Array(localWidth * localHeight);
  let inkPixels = 0;
  for (let localY = 0; localY < localHeight; localY += 1) {
    const y = safeRect.top + localY;
    for (let localX = 0; localX < localWidth; localX += 1) {
      const x = safeRect.left + localX;
      if (pixelExcluded(x, y, exclusions) || !inclusionAllows(inclusionMask, width, x, y)) continue;
      const sourceIndex = (y * width + x) * 4;
      if (rgba[sourceIndex + 3] < 32) continue;
      const distance = compositedColorDistance(
        rgba[sourceIndex],
        rgba[sourceIndex + 1],
        rgba[sourceIndex + 2],
        target,
      );
      if (distance > threshold) continue;
      mask[localY * localWidth + localX] = 1;
      inkPixels += 1;
    }
  }
  // Black axes can connect otherwise distinct curves into a huge closed
  // graph. Remove only long, perpendicular frame strokes at the ROI boundary,
  // never an arbitrary interior vertical curve. Keep a small neighbourhood
  // of boundary guides so manually supplied endpoints remain authoritative.
  if ((!inclusionMask || inclusionMask.mode === "local") && Math.max(target.r, target.g, target.b) < 110) {
    const luminanceAt = (x, y) => {
      x = clamp(x, 0, width - 1); y = clamp(y, 0, height - 1);
      const offset = (y * width + x) * 4;
      return 0.2126 * rgba[offset] + 0.7152 * rgba[offset + 1] + 0.0722 * rgba[offset + 2];
    };
    const frameInk = (x, y, vertical) => {
      const luminance = luminanceAt(x, y);
      const dx = vertical ? 4 : 0, dy = vertical ? 0 : 4;
      // Axes may be grey from antialiasing even when the target is black.
      // Demand contrast on both sides; a shaded region edge alone is not a frame.
      return luminance <= 185 && luminance + 20 <= Math.min(
        luminanceAt(x - dx, y - dy), luminanceAt(x + dx, y + dy),
      );
    };
    const horizontalEdges = [];
    const verticalEdges = [];
    for (let offset = 0; offset <= 3; offset += 1) {
      for (const y of [safeRect.top + offset, safeRect.bottom - offset]) {
        let count = 0;
        for (let x = safeRect.left; x <= safeRect.right; x += 1) if (frameInk(x, y, false)) count += 1;
        if (count >= localWidth * 0.85) horizontalEdges.push(y);
      }
      for (const x of [safeRect.left + offset, safeRect.right - offset]) {
        let count = 0;
        for (let y = safeRect.top; y <= safeRect.bottom; y += 1) if (frameInk(x, y, true)) count += 1;
        if (count >= localHeight * 0.85) verticalEdges.push(x);
      }
    }
    if (horizontalEdges.length && verticalEdges.length) {
      for (let localY = 0; localY < localHeight; localY += 1) {
        const y = safeRect.top + localY;
        for (let localX = 0; localX < localWidth; localX += 1) {
          const index = localY * localWidth + localX;
          if (!mask[index]) continue;
          const x = safeRect.left + localX;
          if (!horizontalEdges.includes(y) && !verticalEdges.includes(x)) continue;
          if (anchors.some(anchor => Math.hypot(anchor.x - x, anchor.y - y) <= 4)) continue;
          mask[index] = 0;
          inkPixels -= 1;
        }
      }
    }
  }
  return { mask, localWidth, localHeight, safeRect, inkPixels };
}

function nearestMaskIndex(maskRecord, anchors, maximumRadius = 10) {
  const { mask, localWidth, localHeight, safeRect } = maskRecord;
  for (const anchor of anchors) {
    const centerX = Math.round(anchor.x) - safeRect.left;
    const centerY = Math.round(anchor.y) - safeRect.top;
    let bestIndex = -1;
    let bestDistance = Infinity;
    for (let offsetY = -maximumRadius; offsetY <= maximumRadius; offsetY += 1) {
      const y = centerY + offsetY;
      if (y < 0 || y >= localHeight) continue;
      for (let offsetX = -maximumRadius; offsetX <= maximumRadius; offsetX += 1) {
        const x = centerX + offsetX;
        if (x < 0 || x >= localWidth) continue;
        const distance = Math.hypot(offsetX, offsetY);
        if (distance > maximumRadius || distance >= bestDistance) continue;
        const index = y * localWidth + x;
        if (!mask[index]) continue;
        bestIndex = index;
        bestDistance = distance;
      }
    }
    if (bestIndex >= 0) return bestIndex;
  }
  return -1;
}

function floodComponent(maskRecord, seedIndex) {
  const { mask, localWidth, localHeight } = maskRecord;
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  const component = [];
  let head = 0;
  let tail = 0;
  queue[tail] = seedIndex;
  tail += 1;
  visited[seedIndex] = 1;
  while (head < tail) {
    const index = queue[head];
    head += 1;
    component.push(index);
    const x = index % localWidth;
    const y = Math.floor(index / localWidth);
    for (const [dx, dy] of neighborOffsets) {
      const nextX = x + dx;
      const nextY = y + dy;
      if (nextX < 0 || nextX >= localWidth || nextY < 0 || nextY >= localHeight) continue;
      const nextIndex = nextY * localWidth + nextX;
      if (!mask[nextIndex] || visited[nextIndex]) continue;
      visited[nextIndex] = 1;
      queue[tail] = nextIndex;
      tail += 1;
    }
  }
  return component;
}

function countMaskComponents(maskRecord) {
  const { mask, localWidth, localHeight } = maskRecord;
  const visited = new Uint8Array(mask.length);
  const queue = new Int32Array(mask.length);
  let count = 0;
  for (let start = 0; start < mask.length; start += 1) {
    if (!mask[start] || visited[start]) continue;
    count += 1;
    let head = 0;
    let tail = 0;
    queue[tail] = start;
    tail += 1;
    visited[start] = 1;
    while (head < tail) {
      const index = queue[head];
      head += 1;
      const x = index % localWidth;
      const y = Math.floor(index / localWidth);
      for (const [dx, dy] of neighborOffsets) {
        const nextX = x + dx;
        const nextY = y + dy;
        if (nextX < 0 || nextX >= localWidth || nextY < 0 || nextY >= localHeight) continue;
        const nextIndex = nextY * localWidth + nextX;
        if (!mask[nextIndex] || visited[nextIndex]) continue;
        visited[nextIndex] = 1;
        queue[tail] = nextIndex;
        tail += 1;
      }
    }
  }
  return count;
}

function cropComponent(maskRecord, component) {
  const { localWidth, safeRect } = maskRecord;
  let minimumX = Infinity;
  let maximumX = -Infinity;
  let minimumY = Infinity;
  let maximumY = -Infinity;
  for (const index of component) {
    const x = index % localWidth;
    const y = Math.floor(index / localWidth);
    minimumX = Math.min(minimumX, x);
    maximumX = Math.max(maximumX, x);
    minimumY = Math.min(minimumY, y);
    maximumY = Math.max(maximumY, y);
  }
  const padding = 1;
  const left = Math.max(0, minimumX - padding);
  const right = Math.min(maskRecord.localWidth - 1, maximumX + padding);
  const top = Math.max(0, minimumY - padding);
  const bottom = Math.min(maskRecord.localHeight - 1, maximumY + padding);
  const width = right - left + 1;
  const height = bottom - top + 1;
  const mask = new Uint8Array(width * height);
  for (const index of component) {
    const sourceX = index % localWidth;
    const sourceY = Math.floor(index / localWidth);
    mask[(sourceY - top) * width + sourceX - left] = 1;
  }
  return {
    mask,
    width,
    height,
    offsetX: safeRect.left + left,
    offsetY: safeRect.top + top,
  };
}


function graphComponentLabels(nodes) {
  const labels = new Int32Array(nodes.length);
  labels.fill(-1);
  let label = 0;
  for (let start = 0; start < nodes.length; start += 1) {
    if (labels[start] >= 0) continue;
    const queue = [start];
    labels[start] = label;
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head];
      for (const neighbor of nodes[current].neighbors) {
        if (labels[neighbor] >= 0) continue;
        labels[neighbor] = label;
        queue.push(neighbor);
      }
    }
    label += 1;
  }
  return labels;
}

function pointRectDistance(point, rect) {
  const dx = Math.max(rect.left - point.x, 0, point.x - rect.right);
  const dy = Math.max(rect.top - point.y, 0, point.y - rect.bottom);
  return Math.hypot(dx, dy);
}

function segmentCrossesRect(left, right, rect) {
  for (let sample = 1; sample < 12; sample += 1) {
    const fraction = sample / 12;
    const x = left.x + (right.x - left.x) * fraction;
    const y = left.y + (right.y - left.y) * fraction;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}

function tangentEntersRect(point, tangent, rect, maximumDistance) {
  const steps = Math.max(3, Math.ceil(maximumDistance));
  for (let step = 1; step <= steps; step += 1) {
    const x = point.x + tangent.x * step;
    const y = point.y + tangent.y * step;
    if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) return true;
  }
  return false;
}

function endpointTangent(nodes, index) {
  if (nodes[index].neighbors.length !== 1) return null;
  let previous = index;
  let current = nodes[index].neighbors[0];
  for (let step = 1; step < 7; step += 1) {
    const next = nodes[current].neighbors.find((neighbor) => neighbor !== previous);
    if (next === undefined || nodes[current].neighbors.length > 2) break;
    previous = current;
    current = next;
  }
  const dx = nodes[index].x - nodes[current].x;
  const dy = nodes[index].y - nodes[current].y;
  const scale = Math.hypot(dx, dy);
  return scale > 0 ? { x: dx / scale, y: dy / scale } : null;
}

function edgeKey(left, right) {
  return left < right ? `${left}:${right}` : `${right}:${left}`;
}

// Rounded brush caps can leave a 1–3 px break where a local Pen rectangle
// meets the unpainted search area. Reconnect only that interface, not erased
// holes or separate strokes. Every intermediate pixel must remain allowed.
function connectLocalPenEntries(nodes, mask, width, height, rect, exclusions) {
  const records = [];
  if (mask?.mode !== "local" || !mask.allowed) return records;
  const labels = graphComponentLabels(nodes);
  const endpoints = nodes.map((node, index) => ({ node, index, tangent: endpointTangent(nodes, index) }))
    .filter(entry => entry.tangent);
  const painted = node => Boolean(mask.data[Math.round(node.y) * width + Math.round(node.x)]);
  const candidates = [];
  for (let i = 0; i < endpoints.length; i += 1) {
    const left = endpoints[i];
    for (const right of endpoints.slice(i + 1)) {
      if (labels[left.index] === labels[right.index] || painted(left.node) === painted(right.node)) continue;
      const distance = pointDistance(left.node, right.node);
      if (distance < 2 || distance > 6) continue;
      const dx = (right.node.x - left.node.x) / distance;
      const dy = (right.node.y - left.node.y) / distance;
      if (left.tangent.x * dx + left.tangent.y * dy < 0.55
        || right.tangent.x * -dx + right.tangent.y * -dy < 0.55) continue;
      candidates.push({ left, right, distance });
    }
  }
  const used = new Set();
  for (const candidate of candidates.sort((a, b) => a.distance - b.distance)) {
    const { left, right, distance } = candidate;
    if (used.has(left.index) || used.has(right.index)) continue;
    // Ambiguous pairings are not evidence for a connection.
    if (candidates.some(other => other !== candidate && Math.abs(other.distance - distance) < 1
      && [other.left.index, other.right.index].some(index => index === left.index || index === right.index))) continue;
    const start = left.node.y * width + left.node.x;
    const end = right.node.y * width + right.node.x;
    const previous = new Map([[start, null]]);
    const queue = [start];
    for (let head = 0; head < queue.length && !previous.has(end); head += 1) {
      const current = queue[head];
      const x = current % width, y = Math.floor(current / width);
      // Orthogonal steps prevent diagonal shortcuts across forbidden pixels.
      for (const [dx, dy] of [[0, -1], [1, 0], [0, 1], [-1, 0]]) {
        const nx = x + dx, ny = y + dy, next = ny * width + nx;
        if (nx < 0 || nx >= width || ny < 0 || ny >= height || previous.has(next)) continue;
        if (nx < rect.left || nx > rect.right || ny < rect.top || ny > rect.bottom) continue;
        if (nx < Math.min(left.node.x, right.node.x) - 2 || nx > Math.max(left.node.x, right.node.x) + 2
          || ny < Math.min(left.node.y, right.node.y) - 2 || ny > Math.max(left.node.y, right.node.y) + 2) continue;
        if (!inclusionAllows(mask, width, nx, ny) || pixelExcluded(nx, ny, exclusions)) continue;
        previous.set(next, current);
        queue.push(next);
      }
    }
    if (!previous.has(end)) continue;
    const route = [];
    for (let cursor = end; cursor !== null; cursor = previous.get(cursor)) route.push({ x: cursor % width, y: Math.floor(cursor / width) });
    route.reverse();
    if (route.length > Math.ceil(distance) + 7) continue;
    const record = { kind: "pen-entry", left: left.index, right: right.index, distance, confidence: 0.6,
      points: route.slice(1, -1).map(point => ({ ...point, observed: false, imageObserved: false,
        confidence: 0.6, penEntryInferred: true, inferenceUncertainty: 2, traceOrientation: "parametric" })) };
    nodes[left.index].neighbors.push(right.index);
    nodes[right.index].neighbors.push(left.index);
    used.add(left.index); used.add(right.index);
    records.push(record);
  }
  return records;
}

function connectOcclusionBridges(nodes, exclusions) {
  if (!nodes.length || !exclusions.length) return { records: [], byEdge: new Map() };
  const labels = graphComponentLabels(nodes);
  const endpoints = nodes.map((node, index) => ({ node, index, tangent: endpointTangent(nodes, index) }))
    .filter((entry) => entry.tangent);
  const candidatesByEdge = new Map();
  for (let leftIndex = 0; leftIndex < endpoints.length; leftIndex += 1) {
    const left = endpoints[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < endpoints.length; rightIndex += 1) {
      const right = endpoints[rightIndex];
      const dx = right.node.x - left.node.x;
      const dy = right.node.y - left.node.y;
      const distance = Math.hypot(dx, dy);
      if (!(distance >= 3)) continue;
      const direction = { x: dx / distance, y: dy / distance };
      const leftAlignment = left.tangent.x * direction.x + left.tangent.y * direction.y;
      const rightAlignment = -(right.tangent.x * direction.x + right.tangent.y * direction.y);
      if (leftAlignment < 0.58 || rightAlignment < 0.58) continue;
      for (let exclusionIndex = 0; exclusionIndex < exclusions.length; exclusionIndex += 1) {
        const exclusion = exclusions[exclusionIndex];
        const diagonal = Math.hypot(
          exclusion.width ?? exclusion.right - exclusion.left + 1,
          exclusion.height ?? exclusion.bottom - exclusion.top + 1,
        );
        if (distance > diagonal + 18) continue;
        if (pointRectDistance(left.node, exclusion) > 7 || pointRectDistance(right.node, exclusion) > 7) continue;
        const expandedExclusion = {
          left: exclusion.left - 3,
          right: exclusion.right + 3,
          top: exclusion.top - 3,
          bottom: exclusion.bottom + 3,
        };
        if (!segmentCrossesRect(left.node, right.node, expandedExclusion)) continue;
        if (!tangentEntersRect(left.node, left.tangent, exclusion, distance * 0.6)
          || !tangentEntersRect(right.node, right.tangent, exclusion, distance * 0.6)) continue;
        const minimumAlignment = Math.min(leftAlignment, rightAlignment);
        const meanAlignment = (leftAlignment + rightAlignment) / 2;
        const componentBonus = labels[left.index] === labels[right.index] ? 0.04 : 0;
        const score = minimumAlignment * 1.6 + meanAlignment
          - distance / Math.max(12, diagonal + 18) * 0.22 + componentBonus;
        const candidate = {
          kind: "occlusion",
          left: left.index,
          right: right.index,
          leftTangent: left.tangent,
          rightTangent: right.tangent,
          distance,
          exclusionIndex,
          score,
          confidence: clamp(0.58 + minimumAlignment * 0.32 - distance / Math.max(12, diagonal + 18) * 0.08, 0.58, 0.88),
        };
        const key = edgeKey(candidate.left, candidate.right);
        const existing = candidatesByEdge.get(key);
        if (!existing || candidate.score > existing.score) candidatesByEdge.set(key, candidate);
      }
    }
  }
  // Duplicate or overlapping exclusion rectangles can nominate the same
  // endpoint pair more than once. They are one geometric alternative, not
  // competing choices, so collapse them before endpoint ambiguity is tested.
  const candidates = [...candidatesByEdge.values()];
  candidates.sort((left, right) => right.score - left.score || left.distance - right.distance);
  const optionsByEndpoint = new Map();
  for (const candidate of candidates) {
    for (const endpoint of [candidate.left, candidate.right]) {
      if (!optionsByEndpoint.has(endpoint)) optionsByEndpoint.set(endpoint, []);
      optionsByEndpoint.get(endpoint).push(candidate);
    }
  }
  const unambiguousBest = (endpoint, candidate) => {
    const options = optionsByEndpoint.get(endpoint) ?? [];
    if (options[0] !== candidate) return false;
    return options.length === 1 || candidate.score - options[1].score >= 0.12;
  };
  const usedEndpoints = new Set();
  const records = [];
  for (const candidate of candidates) {
    if (usedEndpoints.has(candidate.left) || usedEndpoints.has(candidate.right)) continue;
    if (!unambiguousBest(candidate.left, candidate) || !unambiguousBest(candidate.right, candidate)) continue;
    nodes[candidate.left].neighbors.push(candidate.right);
    nodes[candidate.right].neighbors.push(candidate.left);
    usedEndpoints.add(candidate.left);
    usedEndpoints.add(candidate.right);
    records.push(candidate);
  }
  return {
    records,
    byEdge: new Map(records.map((record) => [edgeKey(record.left, record.right), record])),
  };
}

function connectPatternedBridges(nodes, targetStyle) {
  const maximumGap = {
    dotted: 10,
    dashed: 18,
    dashdot: 18,
  }[targetStyle];
  if (!maximumGap || nodes.length < 24) return { records: [], byEdge: new Map() };
  const labels = graphComponentLabels(nodes);
  const componentCount = labels.reduce((maximum, label) => Math.max(maximum, label), -1) + 1;
  if (componentCount < 3) return { records: [], byEdge: new Map() };
  const compactDashDot = targetStyle === "dashdot";
  const componentSizes = new Int32Array(componentCount);
  for (const label of labels) componentSizes[label] += 1;
  const endpoints = nodes.map((node, index) => {
    if (!compactDashDot) {
      const tangent = endpointTangent(nodes, index);
      return tangent ? { node, index, tangent, capacity: 1 } : null;
    }
    const degree = node.neighbors.length;
    if (degree > 1) return null;
    return {
      node,
      index,
      tangent: degree === 1 && componentSizes[labels[index]] > 3
        ? endpointTangent(nodes, index)
        : null,
      capacity: degree === 0 ? 2 : 1,
    };
  }).filter(Boolean);
  const endpointByIndex = new Map(endpoints.map((entry) => [entry.index, entry]));
  const candidates = [];
  for (let leftIndex = 0; leftIndex < endpoints.length; leftIndex += 1) {
    const left = endpoints[leftIndex];
    for (let rightIndex = leftIndex + 1; rightIndex < endpoints.length; rightIndex += 1) {
      const right = endpoints[rightIndex];
      if (labels[left.index] === labels[right.index]) continue;
      const dx = right.node.x - left.node.x;
      const dy = right.node.y - left.node.y;
      const distance = Math.hypot(dx, dy);
      if (distance < 2 || distance > maximumGap) continue;
      const direction = { x: dx / distance, y: dy / distance };
      const leftAlignment = left.tangent
        ? left.tangent.x * direction.x + left.tangent.y * direction.y
        : null;
      const rightAlignment = right.tangent
        ? -(right.tangent.x * direction.x + right.tangent.y * direction.y)
        : null;
      // Six-pixel endpoint tangents are intentionally robust to isolated
      // raster noise, but their direction is quantised on tight curves.
      // Repeated spacing and mutual-best pairing provide the stronger global
      // safeguard, so accept moderate local angular error here.
      const measuredAlignments = [leftAlignment, rightAlignment].filter(Number.isFinite);
      const positionOnlyEndpoints = Number(!left.tangent) + Number(!right.tangent);
      const minimumAcceptedAlignment = compactDashDot && positionOnlyEndpoints ? -1 : 0.58;
      if (measuredAlignments.some((alignment) => alignment < minimumAcceptedAlignment)) continue;
      const minimumAlignment = measuredAlignments.length ? Math.min(...measuredAlignments) : 0.72;
      const meanAlignment = measuredAlignments.length
        ? measuredAlignments.reduce((sum, alignment) => sum + alignment, 0) / measuredAlignments.length
        : 0.72;
      candidates.push({
        kind: "pattern-gap",
        left: left.index,
        right: right.index,
        leftTangent: left.tangent,
        rightTangent: right.tangent,
        distance,
        exclusionIndex: -1,
        score: minimumAlignment * 1.7 + meanAlignment - distance / maximumGap * 0.3
          - positionOnlyEndpoints * 0.06,
        confidence: clamp(
          0.62 + minimumAlignment * 0.3 - distance / maximumGap * 0.08
            - positionOnlyEndpoints * 0.06,
          0.54,
          0.88,
        ),
      });
    }
  }
  candidates.sort((left, right) => right.score - left.score || left.distance - right.distance);
  const optionsByEndpoint = new Map();
  for (const candidate of candidates) {
    for (const endpoint of [candidate.left, candidate.right]) {
      if (!optionsByEndpoint.has(endpoint)) optionsByEndpoint.set(endpoint, []);
      optionsByEndpoint.get(endpoint).push(candidate);
    }
  }
  const clearBest = (endpoint, candidate) => {
    const options = optionsByEndpoint.get(endpoint) ?? [];
    const endpointRecord = endpointByIndex.get(endpoint);
    if (endpointRecord?.capacity === 2) {
      const rank = options.indexOf(candidate);
      return rank >= 0 && rank < 4 && candidate.score >= (options[0]?.score ?? -Infinity) - 0.28;
    }
    if (options[0] !== candidate) return false;
    return options.length === 1 || candidate.score - options[1].score >= 0.06;
  };
  const usedEndpointCounts = new Map();
  const usedEndpointDirections = new Map();
  const endpointAvailable = (endpoint, other) => {
    const endpointRecord = endpointByIndex.get(endpoint);
    const usedCount = usedEndpointCounts.get(endpoint) ?? 0;
    if (!endpointRecord || usedCount >= endpointRecord.capacity) return false;
    if (endpointRecord.capacity === 1 || usedCount === 0) return true;
    const dx = nodes[other].x - nodes[endpoint].x;
    const dy = nodes[other].y - nodes[endpoint].y;
    const scale = Math.hypot(dx, dy);
    if (!(scale > 0)) return false;
    const direction = { x: dx / scale, y: dy / scale };
    return (usedEndpointDirections.get(endpoint) ?? []).every((used) => (
      used.x * direction.x + used.y * direction.y <= -0.15
    ));
  };
  const useEndpoint = (endpoint, other) => {
    usedEndpointCounts.set(endpoint, (usedEndpointCounts.get(endpoint) ?? 0) + 1);
    const dx = nodes[other].x - nodes[endpoint].x;
    const dy = nodes[other].y - nodes[endpoint].y;
    const scale = Math.hypot(dx, dy);
    if (!(scale > 0)) return;
    if (!usedEndpointDirections.has(endpoint)) usedEndpointDirections.set(endpoint, []);
    usedEndpointDirections.get(endpoint).push({ x: dx / scale, y: dy / scale });
  };
  const proposed = [];
  for (const candidate of candidates) {
    if (!endpointAvailable(candidate.left, candidate.right)
      || !endpointAvailable(candidate.right, candidate.left)) continue;
    if (!clearBest(candidate.left, candidate) || !clearBest(candidate.right, candidate)) continue;
    useEndpoint(candidate.left, candidate.right);
    useEndpoint(candidate.right, candidate.left);
    proposed.push(candidate);
  }
  if (proposed.length < 3) return { records: [], byEdge: new Map() };
  if (compactDashDot) {
    const seedGaps = proposed.map((record) => record.distance).sort((left, right) => left - right);
    const seedMedian = seedGaps[Math.floor(seedGaps.length / 2)];
    const fingerprintTolerance = Math.max(2.5, seedMedian * 0.5);
    const supplementalTolerance = Math.max(4, seedMedian * 0.75);
    const seedConsistent = seedGaps.filter((gap) => Math.abs(gap - seedMedian) <= fingerprintTolerance);
    if (seedConsistent.length < 3 || seedConsistent.length / proposed.length < 0.7) {
      return { records: [], byEdge: new Map() };
    }
    const proposedEdges = new Set(proposed.map((record) => edgeKey(record.left, record.right)));
    const nearestDistanceByEndpoint = new Map();
    for (const candidate of candidates) {
      for (const endpoint of [candidate.left, candidate.right]) {
        nearestDistanceByEndpoint.set(
          endpoint,
          Math.min(nearestDistanceByEndpoint.get(endpoint) ?? Infinity, candidate.distance),
        );
      }
    }
    // Once repeated, tangent-compatible gaps establish a dash-dot fingerprint,
    // admit mutual-nearest matches at the same spacing. This recovers tiny dot
    // components whose one-pixel direction cannot produce a decisive score,
    // while rejecting skips across an entire dot-plus-two-gaps interval.
    for (const candidate of [...candidates].sort((left, right) => left.distance - right.distance)) {
      const key = edgeKey(candidate.left, candidate.right);
      if (proposedEdges.has(key)) continue;
      if (Math.abs(candidate.distance - seedMedian) > supplementalTolerance) continue;
      if (candidate.distance > (nearestDistanceByEndpoint.get(candidate.left) ?? Infinity) + 2
        || candidate.distance > (nearestDistanceByEndpoint.get(candidate.right) ?? Infinity) + 2) continue;
      if (!endpointAvailable(candidate.left, candidate.right)
        || !endpointAvailable(candidate.right, candidate.left)) continue;
      useEndpoint(candidate.left, candidate.right);
      useEndpoint(candidate.right, candidate.left);
      proposed.push(candidate);
      proposedEdges.add(key);
    }
  }
  const sortedGaps = proposed.map((record) => record.distance).sort((left, right) => left - right);
  const medianGap = sortedGaps[Math.floor(sortedGaps.length / 2)];
  const gapTolerance = Math.max(2.5, medianGap * 0.5);
  const consistentRecords = proposed.filter((record) => Math.abs(record.distance - medianGap) <= gapTolerance);
  if (consistentRecords.length < 3 || consistentRecords.length / proposed.length < 0.7) {
    return { records: [], byEdge: new Map() };
  }
  // Only the repeated-spacing fingerprint is admissible evidence. Keeping the
  // remaining outliers would let up to 30% of accepted bridges jump to another
  // same-colour component even though those gaps failed the pattern model.
  const records = consistentRecords;
  for (const record of records) {
    nodes[record.left].neighbors.push(record.right);
    nodes[record.right].neighbors.push(record.left);
  }
  return {
    records,
    byEdge: new Map(records.map((record) => [edgeKey(record.left, record.right), record])),
    medianGap,
    gapConsistency: consistentRecords.length / proposed.length,
  };
}

function hermiteBridgePoints(nodes, record, from, to) {
  const forward = from === record.left;
  if (record.points) return (forward ? record.points : [...record.points].reverse()).map(point => ({ ...point }));
  const start = nodes[from];
  const end = nodes[to];
  const chordScale = Math.max(1e-9, Math.hypot(end.x - start.x, end.y - start.y));
  const chord = { x: (end.x - start.x) / chordScale, y: (end.y - start.y) / chordScale };
  const startTangent = (forward ? record.leftTangent : record.rightTangent) ?? chord;
  const endOutwardTangent = (forward ? record.rightTangent : record.leftTangent) ?? {
    x: -chord.x,
    y: -chord.y,
  };
  // Masked spans need a near-unit chord scale so endpoint tangents can meet in
  // a hidden arc. Short repeated dash gaps stay closer to their local chord.
  const derivativeScale = record.distance * (record.kind === "occlusion" ? 0.9 : 0.55);
  const steps = Math.max(3, Math.ceil(record.distance));
  const points = [];
  for (let step = 1; step < steps; step += 1) {
    const fraction = step / steps;
    const fraction2 = fraction * fraction;
    const fraction3 = fraction2 * fraction;
    const h00 = 2 * fraction3 - 3 * fraction2 + 1;
    const h10 = fraction3 - 2 * fraction2 + fraction;
    const h01 = -2 * fraction3 + 3 * fraction2;
    const h11 = fraction3 - fraction2;
    const unsupportedDistance = Math.min(fraction, 1 - fraction) * record.distance;
    const inferenceUncertainty = clamp(
      0.8 + unsupportedDistance * 0.12 + (1 - record.confidence) * 3,
      1,
      18,
    );
    const patterned = record.kind === "pattern-gap";
    points.push({
      x: h00 * start.x + h10 * startTangent.x * derivativeScale
        + h01 * end.x - h11 * endOutwardTangent.x * derivativeScale,
      y: h00 * start.y + h10 * startTangent.y * derivativeScale
        + h01 * end.y - h11 * endOutwardTangent.y * derivativeScale,
      observed: false,
      imageObserved: false,
      confidence: clamp(record.confidence - Math.sin(Math.PI * fraction) * 0.24, 0.28, 0.68),
      candidateCount: 1,
      origin: patterned ? "pattern-gap-model" : "occlusion-model",
      occlusionInferred: !patterned,
      patternInferred: patterned,
      inferenceMethod: patterned ? "parametric-pattern-gap" : "parametric-tangent-bridge",
      inferenceModel: patterned ? "cubic-hermite-pattern" : "cubic-hermite-tangent",
      inferenceModelScore: record.confidence,
      modelDisagreement: (1 - record.confidence) * unsupportedDistance * 0.18,
      unsupportedDistance,
      inferenceUncertainty,
      traceOrientation: "parametric",
    });
  }
  return points;
}

function expandOrderedNodes(nodes, ordered, bridgeByEdge, { closed, confidence, topologyReview }) {
  const path = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const nodeIndex = ordered[index];
    path.push({
      x: nodes[nodeIndex].x,
      y: nodes[nodeIndex].y,
      observed: true,
      confidence,
      candidateCount: nodes[nodeIndex].neighbors.length,
      traceOrientation: "parametric",
      closedPath: closed,
      topologyReview,
    });
    const hasNext = index + 1 < ordered.length || closed;
    if (!hasNext) continue;
    const nextIndex = ordered[(index + 1) % ordered.length];
    const bridge = bridgeByEdge.get(edgeKey(nodeIndex, nextIndex));
    if (bridge) path.push(...hermiteBridgePoints(nodes, bridge, nodeIndex, nextIndex));
  }
  return path;
}

function graphTwoCore(nodes) {
  const active = new Uint8Array(nodes.length);
  active.fill(1);
  const degrees = Int32Array.from(nodes, (node) => node.neighbors.length);
  const queue = new Int32Array(nodes.length);
  let head = 0;
  let tail = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    if (degrees[index] < 2) {
      queue[tail] = index;
      tail += 1;
    }
  }
  while (head < tail) {
    const index = queue[head];
    head += 1;
    if (!active[index]) continue;
    active[index] = 0;
    for (const neighbor of nodes[index].neighbors) {
      if (!active[neighbor]) continue;
      degrees[neighbor] -= 1;
      if (degrees[neighbor] === 1) {
        queue[tail] = neighbor;
        tail += 1;
      }
    }
  }
  return { active, degrees };
}

function activeComponents(nodes, active) {
  const visited = new Uint8Array(nodes.length);
  const components = [];
  for (let start = 0; start < nodes.length; start += 1) {
    if (!active[start] || visited[start]) continue;
    const component = [];
    const queue = [start];
    visited[start] = 1;
    while (queue.length) {
      const index = queue.pop();
      component.push(index);
      for (const neighbor of nodes[index].neighbors) {
        if (!active[neighbor] || visited[neighbor]) continue;
        visited[neighbor] = 1;
        queue.push(neighbor);
      }
    }
    components.push(component);
  }
  return components;
}

function pointDistance(left, right) {
  return Math.hypot(left.x - right.x, left.y - right.y);
}

function nearestNodeIndex(nodes, candidates, point) {
  let best = -1;
  let bestDistance = Infinity;
  for (const index of candidates) {
    const distance = pointDistance(nodes[index], point);
    if (distance < bestDistance) {
      best = index;
      bestDistance = distance;
    }
  }
  return { index: best, distance: bestDistance };
}

function chooseCycleComponent(nodes, active, anchors) {
  const components = activeComponents(nodes, active);
  return components.map((component) => {
    const anchorDistances = anchors.map((anchor) => nearestNodeIndex(nodes, component, anchor).distance);
    const meanAnchorDistance = anchorDistances.length
      ? anchorDistances.reduce((sum, distance) => sum + distance, 0) / anchorDistances.length
      : 0;
    const branching = component.filter((index) => (
      nodes[index].neighbors.filter((neighbor) => active[neighbor]).length > 2
    )).length;
    return {
      component,
      meanAnchorDistance,
      maximumAnchorDistance: Math.max(...anchorDistances),
      branching,
      score: component.length - meanAnchorDistance * 8 - branching * 4,
    };
  }).filter((entry) => entry.component.length >= 16 && entry.maximumAnchorDistance <= 10)
    .sort((left, right) => right.score - left.score)[0] ?? null;
}

function orderedDegreeTwoCycle(nodes, active, component, start) {
  const activeNeighbors = (index) => nodes[index].neighbors.filter((neighbor) => active[neighbor]);
  if (component.some((index) => activeNeighbors(index).length !== 2)) return null;
  const firstNeighbors = activeNeighbors(start);
  if (firstNeighbors.length !== 2) return null;
  const walk = (first) => {
    const ordered = [start];
    let previous = start;
    let current = first;
    while (current !== start && ordered.length <= component.length + 1) {
      ordered.push(current);
      const next = activeNeighbors(current).find((neighbor) => neighbor !== previous);
      if (next === undefined) return null;
      previous = current;
      current = next;
    }
    return current === start && ordered.length === component.length ? ordered : null;
  };
  return walk(firstNeighbors[0]);
}

function bfsPath(nodes, active, source, target, forbidden) {
  const previous = new Int32Array(nodes.length);
  previous.fill(-1);
  const visited = new Uint8Array(nodes.length);
  const queue = new Int32Array(nodes.length);
  let head = 0;
  let tail = 0;
  queue[tail] = source;
  tail += 1;
  visited[source] = 1;
  if (forbidden >= 0) visited[forbidden] = 1;
  while (head < tail) {
    const index = queue[head];
    head += 1;
    if (index === target) break;
    for (const neighbor of nodes[index].neighbors) {
      if (!active[neighbor] || visited[neighbor]) continue;
      visited[neighbor] = 1;
      previous[neighbor] = index;
      queue[tail] = neighbor;
      tail += 1;
    }
  }
  if (!visited[target]) return null;
  const path = [];
  let cursor = target;
  while (cursor >= 0) {
    path.push(cursor);
    if (cursor === source) break;
    cursor = previous[cursor];
  }
  return path.at(-1) === source ? path.reverse() : null;
}

function orderedBranchedCycle(nodes, active, start, anchors) {
  const neighbors = nodes[start].neighbors.filter((neighbor) => active[neighbor]);
  const candidates = [];
  for (let leftIndex = 0; leftIndex < neighbors.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < neighbors.length; rightIndex += 1) {
      const path = bfsPath(nodes, active, neighbors[leftIndex], neighbors[rightIndex], start);
      if (!path || path.length < 14) continue;
      const cycle = [start, ...path];
      const anchorDistance = anchors.reduce((sum, anchor) => (
        sum + nearestNodeIndex(nodes, cycle, anchor).distance
      ), 0);
      candidates.push({ cycle, score: cycle.length - anchorDistance * 10 });
    }
  }
  return candidates.sort((left, right) => right.score - left.score)[0]?.cycle ?? null;
}

function orderedEulerianCycle(nodes, active, component, start) {
  const componentSet = new Set(component);
  const adjacency = Array.from({ length: nodes.length }, () => []);
  let edgeCount = 0;
  for (const nodeIndex of component) {
    for (const neighbor of nodes[nodeIndex].neighbors) {
      if (!active[neighbor] || !componentSet.has(neighbor) || neighbor <= nodeIndex) continue;
      adjacency[nodeIndex].push({ edgeId: edgeCount, neighbor });
      adjacency[neighbor].push({ edgeId: edgeCount, neighbor: nodeIndex });
      edgeCount += 1;
    }
  }
  if (!edgeCount) return null;
  const oddNodes = component.filter((index) => adjacency[index].length % 2 !== 0);
  // A rasterised crossing often becomes two adjacent degree-three pixels with
  // a one-pixel shared bridge. The mathematical curve visits that bridge
  // twice, but the binary skeleton contains it once. Duplicate only this very
  // short odd-to-odd bridge; longer odd paths are genuine branching and stay
  // unsupported rather than being silently invented.
  if (oddNodes.length === 2) {
    const [source, target] = oddNodes;
    const queue = [source];
    const previousNode = new Int32Array(nodes.length);
    const previousEdge = new Int32Array(nodes.length);
    previousNode.fill(-1);
    previousEdge.fill(-1);
    previousNode[source] = source;
    for (let head = 0; head < queue.length && previousNode[target] < 0; head += 1) {
      const current = queue[head];
      for (const entry of adjacency[current]) {
        if (previousNode[entry.neighbor] >= 0) continue;
        previousNode[entry.neighbor] = current;
        previousEdge[entry.neighbor] = entry.edgeId;
        queue.push(entry.neighbor);
      }
    }
    if (previousNode[target] < 0) return null;
    const bridge = [];
    let cursor = target;
    while (cursor !== source) {
      const previous = previousNode[cursor];
      bridge.push([previous, cursor]);
      cursor = previous;
    }
    if (bridge.length > 8 || pointDistance(nodes[source], nodes[target]) > 6) return null;
    for (const [left, right] of bridge) {
      adjacency[left].push({ edgeId: edgeCount, neighbor: right });
      adjacency[right].push({ edgeId: edgeCount, neighbor: left });
      edgeCount += 1;
    }
  } else if (oddNodes.length !== 0) {
    return null;
  }
  const used = new Uint8Array(edgeCount);
  const stack = [start];
  const circuit = [];
  const continuationScore = (previous, current, candidate) => {
    if (previous === undefined) return -candidate.edgeId * 1e-9;
    const incomingX = nodes[current].x - nodes[previous].x;
    const incomingY = nodes[current].y - nodes[previous].y;
    const outgoingX = nodes[candidate.neighbor].x - nodes[current].x;
    const outgoingY = nodes[candidate.neighbor].y - nodes[current].y;
    const scale = Math.hypot(incomingX, incomingY) * Math.hypot(outgoingX, outgoingY);
    return scale > 0 ? (incomingX * outgoingX + incomingY * outgoingY) / scale : -1;
  };
  while (stack.length) {
    const current = stack.at(-1);
    const previous = stack.length >= 2 ? stack.at(-2) : undefined;
    const candidates = adjacency[current].filter((entry) => !used[entry.edgeId]);
    if (!candidates.length) {
      circuit.push(stack.pop());
      continue;
    }
    const next = candidates.sort((left, right) => (
      continuationScore(previous, current, right) - continuationScore(previous, current, left)
      || left.edgeId - right.edgeId
    ))[0];
    used[next.edgeId] = 1;
    stack.push(next.neighbor);
  }
  const ordered = circuit.reverse();
  if (ordered.length !== edgeCount + 1 || ordered[0] !== ordered.at(-1)) return null;
  ordered.pop();
  return ordered;
}

function rotateCycleToStart(cycle, start) {
  const index = cycle.indexOf(start);
  if (index <= 0) return [...cycle];
  return [...cycle.slice(index), ...cycle.slice(0, index)];
}

function orientCycleByGuides(nodes, cycle, anchors) {
  if (anchors.length < 2 || cycle.length < 3) return cycle;
  const secondGuideIndex = nearestNodeIndex(nodes, cycle, anchors[1]).index;
  const forwardIndex = cycle.indexOf(secondGuideIndex);
  if (forwardIndex <= cycle.length / 2) return cycle;
  return [cycle[0], ...cycle.slice(1).reverse()];
}

function bilinearTargetAffinity(options, x, y) {
  const {
    rgba,
    width,
    height,
    rect,
    target,
    threshold,
    exclusions = [],
    inclusionMask = null,
  } = options;
  if (x < 0 || x > width - 1 || y < 0 || y > height - 1) return 0;
  if (rect && (x < rect.left || x > rect.right || y < rect.top || y > rect.bottom)) return 0;
  if (pixelExcluded(x, y, exclusions) || !inclusionAllows(inclusionMask, width, x, y)) return 0;
  const left = Math.floor(x);
  const right = Math.min(width - 1, left + 1);
  const top = Math.floor(y);
  const bottom = Math.min(height - 1, top + 1);
  const fractionX = x - left;
  const fractionY = y - top;
  const weightedPixels = [
    { x: left, y: top, weight: (1 - fractionX) * (1 - fractionY) },
    { x: right, y: top, weight: fractionX * (1 - fractionY) },
    { x: left, y: bottom, weight: (1 - fractionX) * fractionY },
    { x: right, y: bottom, weight: fractionX * fractionY },
  ];
  for (const sample of weightedPixels) {
    if (sample.weight <= 1e-9) continue;
    if (rect && (
      sample.x < rect.left || sample.x > rect.right
      || sample.y < rect.top || sample.y > rect.bottom
    )) return 0;
    if (pixelExcluded(sample.x, sample.y, exclusions)
      || !inclusionAllows(inclusionMask, width, sample.x, sample.y)) return 0;
    if (rgba[(sample.y * width + sample.x) * 4 + 3] < 32) return 0;
  }
  const color = [0, 1, 2, 3].map((channel) => {
    const topLeft = rgba[(top * width + left) * 4 + channel];
    const topRight = rgba[(top * width + right) * 4 + channel];
    const bottomLeft = rgba[(bottom * width + left) * 4 + channel];
    const bottomRight = rgba[(bottom * width + right) * 4 + channel];
    const topValue = topLeft + (topRight - topLeft) * fractionX;
    const bottomValue = bottomLeft + (bottomRight - bottomLeft) * fractionX;
    return topValue + (bottomValue - topValue) * fractionY;
  });
  if (color[3] < 32) return 0;
  const distance = compositedColorDistance(color[0], color[1], color[2], target);
  return clamp(1 - distance / Math.max(2, threshold + 7), 0, 1)
    * clamp(color[3] / 255, 0, 1);
}

function refineParametricCenterline(path, options, { closed = false } = {}) {
  let refined = path.map((point) => ({ ...point }));
  for (let pass = 0; pass < 2; pass += 1) {
    refined = refined.map((point, index) => {
      // Guides are user-owned constraints, while inferred bridge samples have
      // no supporting image evidence. Neither may be pulled toward pixels in
      // or around a hidden/masked span.
      if (point.anchor || point.observed === false) return point;
      const previous = closed
        ? refined[(index - 2 + refined.length) % refined.length]
        : refined[Math.max(0, index - 2)];
      const next = closed
        ? refined[(index + 2) % refined.length]
        : refined[Math.min(refined.length - 1, index + 2)];
      const tangentX = next.x - previous.x;
      const tangentY = next.y - previous.y;
      const scale = Math.hypot(tangentX, tangentY);
      if (!(scale > 0)) return point;
      const normalX = -tangentY / scale;
      const normalY = tangentX / scale;
      const samples = [];
      for (let offset = -4; offset <= 4.0001; offset += 0.5) {
        samples.push({
          offset,
          affinity: bilinearTargetAffinity(
            options,
            point.x + normalX * offset,
            point.y + normalY * offset,
          ),
        });
      }
      const center = samples.findIndex((sample) => Math.abs(sample.offset) < 1e-9);
      let start = center;
      let end = center;
      while (start > 0 && samples[start - 1].affinity >= 0.08) start -= 1;
      while (end + 1 < samples.length && samples[end + 1].affinity >= 0.08) end += 1;
      let total = 0;
      let weightedOffset = 0;
      for (let sampleIndex = start; sampleIndex <= end; sampleIndex += 1) {
        total += samples[sampleIndex].affinity;
        weightedOffset += samples[sampleIndex].offset * samples[sampleIndex].affinity;
      }
      if (!(total > 0.2)) return point;
      const shift = clamp(weightedOffset / total, -2, 2);
      return {
        ...point,
        x: point.x + normalX * shift,
        y: point.y + normalY * shift,
        thickness: Math.max(1, (end - start + 1) * 0.5),
        centerRefined: true,
        centerShift: shift,
      };
    });
  }
  return refined;
}

function chooseOpenComponent(nodes, anchors) {
  const active = new Uint8Array(nodes.length);
  active.fill(1);
  return activeComponents(nodes, active).map((component) => {
    const componentSet = new Set(component);
    const degrees = component.map((index) => (
      nodes[index].neighbors.filter((neighbor) => componentSet.has(neighbor)).length
    ));
    const endpoints = component.filter((_, index) => degrees[index] === 1);
    const branches = degrees.filter((degree) => degree > 2).length;
    const anchorDistances = anchors.map(anchor => nearestNodeIndex(nodes, component, anchor).distance);
    const meanAnchorDistance = anchors.length
      ? anchorDistances.reduce((sum, distance) => sum + distance, 0) / anchors.length : 0;
    const simplePath = endpoints.length === 2 && branches === 0
      && degrees.every((degree) => degree >= 1 && degree <= 2);
    return {
      component,
      endpoints,
      branches,
      meanAnchorDistance,
      simplePath,
      maximumAnchorDistance: Math.max(...anchorDistances),
      score: (simplePath ? 10000 : 0) + component.length - meanAnchorDistance * 8 - branches * 20,
    };
  }).filter((entry) => entry.component.length >= 16 && entry.simplePath && entry.maximumAnchorDistance <= 10)
    .sort((left, right) => right.score - left.score)[0] ?? null;
}

function orderedSimpleOpenPath(nodes, selected, anchors) {
  if (!selected?.simplePath || selected.endpoints.length !== 2) return null;
  const componentSet = new Set(selected.component);
  const walk = (start) => {
    const ordered = [];
    let previous = -1;
    let current = start;
    while (current >= 0 && ordered.length <= selected.component.length) {
      ordered.push(current);
      const next = nodes[current].neighbors.find((neighbor) => (
        neighbor !== previous && componentSet.has(neighbor)
      ));
      if (next === undefined) break;
      previous = current;
      current = next;
    }
    return ordered.length === selected.component.length ? ordered : null;
  };
  let ordered = walk(selected.endpoints[0]);
  if (!ordered) return null;
  if (anchors.length >= 2) {
    const firstIndex = ordered.indexOf(nearestNodeIndex(nodes, ordered, anchors[0]).index);
    const secondIndex = ordered.indexOf(nearestNodeIndex(nodes, ordered, anchors[1]).index);
    if (firstIndex > secondIndex) ordered.reverse();
  } else if (anchors.length === 1) {
    const firstDistance = pointDistance(nodes[ordered[0]], anchors[0]);
    const lastDistance = pointDistance(nodes[ordered.at(-1)], anchors[0]);
    if (lastDistance < firstDistance) ordered.reverse();
  }
  return ordered;
}

function chooseGuidedBranchedComponent(nodes, anchors) {
  if (anchors.length < 2) return null;
  const active = new Uint8Array(nodes.length);
  active.fill(1);
  return activeComponents(nodes, active).map((component) => {
    const componentSet = new Set(component);
    const degrees = new Map(component.map((index) => [
      index,
      nodes[index].neighbors.filter((neighbor) => componentSet.has(neighbor)).length,
    ]));
    const endpoints = component.filter((index) => degrees.get(index) === 1);
    const branches = component.filter((index) => degrees.get(index) > 2).length;
    const anchorDistances = anchors.map((anchor) => nearestNodeIndex(nodes, component, anchor).distance);
    const meanAnchorDistance = anchorDistances.reduce((sum, distance) => sum + distance, 0)
      / anchorDistances.length;
    return {
      component,
      endpoints,
      branches,
      meanAnchorDistance,
      maximumAnchorDistance: Math.max(...anchorDistances),
      score: component.length - meanAnchorDistance * 10 - branches * 3,
    };
  }).filter((entry) => (
    entry.component.length >= 16
    && entry.endpoints.length >= 2
    && entry.branches > 0
    && entry.maximumAnchorDistance <= 10
  )).sort((left, right) => right.score - left.score)[0] ?? null;
}

function shortestComponentPath(nodes, componentSet, source, target) {
  const previous = new Int32Array(nodes.length);
  previous.fill(-1);
  const queue = new Int32Array(componentSet.size);
  let head = 0;
  let tail = 0;
  queue[tail] = source;
  tail += 1;
  previous[source] = source;
  while (head < tail && previous[target] < 0) {
    const current = queue[head];
    head += 1;
    for (const neighbor of nodes[current].neighbors) {
      if (!componentSet.has(neighbor) || previous[neighbor] >= 0) continue;
      previous[neighbor] = current;
      queue[tail] = neighbor;
      tail += 1;
    }
  }
  if (previous[target] < 0) return null;
  const path = [];
  let cursor = target;
  while (cursor !== source) {
    path.push(cursor);
    cursor = previous[cursor];
  }
  path.push(source);
  return path.reverse();
}

function junctionTurnPenalty(nodes, route) {
  const distances = new Float64Array(route.length);
  const junctions = [];
  for (let index = 0; index < route.length; index += 1) {
    if (index) distances[index] = distances[index - 1]
      + pointDistance(nodes[route[index - 1]], nodes[route[index]]);
    if (nodes[route[index]].neighbors.length > 2) junctions.push(index);
  }
  let penalty = 0;
  for (let index = 0; index < junctions.length; index += 1) {
    const first = junctions[index];
    let last = first;
    // A raster crossing can contain several adjacent branching pixels. Treat
    // those as one junction and measure tangents outside its jagged centre.
    while (index + 1 < junctions.length && distances[junctions[index + 1]] - distances[last] <= 6) {
      last = junctions[++index];
    }
    let before = first;
    let after = last;
    while (before > 0 && distances[first] - distances[before] < 6) before -= 1;
    while (after + 1 < route.length && distances[after] - distances[last] < 6) after += 1;
    const incoming = {
      x: nodes[route[first]].x - nodes[route[before]].x,
      y: nodes[route[first]].y - nodes[route[before]].y,
    };
    const outgoing = {
      x: nodes[route[after]].x - nodes[route[last]].x,
      y: nodes[route[after]].y - nodes[route[last]].y,
    };
    const scale = Math.hypot(incoming.x, incoming.y) * Math.hypot(outgoing.x, outgoing.y);
    if (scale > 0) penalty += 1 - clamp((incoming.x * outgoing.x + incoming.y * outgoing.y) / scale, -1, 1);
  }
  // Continuity resolves similarly supported alternatives; it must not outweigh
  // even a one-pixel guide-distance advantage on a graph with many junctions.
  return Math.min(4, penalty);
}

function orderedGuidedBranchedPath(nodes, selected, anchors) {
  if (!selected || anchors.length < 2) return null;
  const componentSet = new Set(selected.component);

  // A Pen stroke already supplies the route geometry, so users should not
  // have to add guides in exact traversal order. First look for an endpoint
  // pair whose shortest graph path passes close to every guide. This removes
  // branches introduced by same-colour crossings and axes while allowing the
  // guides to be inserted later in their geometric order along the path.
  // Limit very noisy endpoint sets before the O(E²) search.
  const candidateEndpoints = selected.endpoints.length <= 24
    ? selected.endpoints
    : [...selected.endpoints].sort((left, right) => {
      const leftDistance = Math.min(...anchors.map((anchor) => pointDistance(nodes[left], anchor)));
      const rightDistance = Math.min(...anchors.map((anchor) => pointDistance(nodes[right], anchor)));
      return leftDistance - rightDistance;
    }).slice(0, 24);
  let automatic = null;
  for (let leftIndex = 0; leftIndex < candidateEndpoints.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidateEndpoints.length; rightIndex += 1) {
      const route = shortestComponentPath(
        nodes,
        componentSet,
        candidateEndpoints[leftIndex],
        candidateEndpoints[rightIndex],
      );
      if (!route?.length) continue;
      const guideDistances = anchors.map((anchor) => nearestNodeIndex(nodes, route, anchor).distance);
      const maximumGuideDistance = Math.max(...guideDistances);
      if (maximumGuideDistance > 10) continue;
      const meanGuideDistance = guideDistances.reduce((sum, distance) => sum + distance, 0)
        / guideDistances.length;
      // Guides have priority. Among equally supported routes, continue through
      // crossings rather than turn into a longer same-colour curve. Length is
      // only a bounded final tie-breaker, not evidence of curve identity.
      const score = maximumGuideDistance * 1000 + meanGuideDistance * 100
        + junctionTurnPenalty(nodes, route) * 20 - route.length / (route.length + 100);
      if (!automatic || score < automatic.score) automatic = { route, score };
    }
  }
  if (automatic) {
    const firstGuide = anchors[0];
    if (pointDistance(nodes[automatic.route.at(-1)], firstGuide)
      < pointDistance(nodes[automatic.route[0]], firstGuide)) automatic.route.reverse();
    return automatic.route;
  }

  // Fall back to the original explicitly ordered routing for cases where no
  // single endpoint-to-endpoint path is supported by every guide (for example
  // an intentional route through a more complex branched graph).
  const guideNodes = anchors.map((anchor) => nearestNodeIndex(nodes, selected.component, anchor).index);
  const start = [...selected.endpoints].sort((left, right) => (
    pointDistance(nodes[left], anchors[0]) - pointDistance(nodes[right], anchors[0])
  ))[0];
  const end = [...selected.endpoints].filter((index) => index !== start).sort((left, right) => (
    pointDistance(nodes[left], anchors.at(-1)) - pointDistance(nodes[right], anchors.at(-1))
  ))[0];
  if (start === undefined || end === undefined) return null;
  const waypoints = [start, ...guideNodes, end].filter((node, index, values) => (
    index === 0 || node !== values[index - 1]
  ));
  const ordered = [];
  for (let index = 1; index < waypoints.length; index += 1) {
    const segment = shortestComponentPath(nodes, componentSet, waypoints[index - 1], waypoints[index]);
    if (!segment?.length) return null;
    ordered.push(...(ordered.length ? segment.slice(1) : segment));
  }
  const usedEdges = new Set();
  let repeatedEdges = 0;
  for (let index = 1; index < ordered.length; index += 1) {
    const edge = ordered[index - 1] < ordered[index]
      ? `${ordered[index - 1]}:${ordered[index]}`
      : `${ordered[index]}:${ordered[index - 1]}`;
    if (usedEdges.has(edge)) repeatedEdges += 1;
    usedEdges.add(edge);
  }
  if (repeatedEdges > Math.max(2, ordered.length * 0.03)) return null;
  return ordered;
}

function pathArcLength(path, closed = false) {
  if (path.length < 2) return 0;
  let length = 0;
  for (let index = 1; index < path.length; index += 1) length += pointDistance(path[index - 1], path[index]);
  if (closed) length += pointDistance(path.at(-1), path[0]);
  return length;
}

function nearestSegmentProjection(path, point, closed) {
  if (path.length === 1) {
    return { segmentIndex: 0, fraction: 0, distance: pointDistance(path[0], point) };
  }
  const segmentCount = closed ? path.length : path.length - 1;
  let best = null;
  for (let segmentIndex = 0; segmentIndex < segmentCount; segmentIndex += 1) {
    const left = path[segmentIndex];
    const right = path[(segmentIndex + 1) % path.length];
    const dx = right.x - left.x;
    const dy = right.y - left.y;
    const lengthSquared = dx * dx + dy * dy;
    const fraction = lengthSquared > 0
      ? clamp(((point.x - left.x) * dx + (point.y - left.y) * dy) / lengthSquared, 0, 1)
      : 0;
    const projection = {
      x: left.x + dx * fraction,
      y: left.y + dy * fraction,
    };
    const distance = pointDistance(projection, point);
    if (!best || distance < best.distance - 1e-9) {
      best = { segmentIndex, fraction, distance };
    }
  }
  return best;
}

function insertExactGuides(path, anchors, { closed = false, imageOptions } = {}) {
  if (!path.length || !anchors.length) {
    return path.map((point, index) => ({ ...point, parametricOrder: index }));
  }
  const insertionsBySegment = new Map();
  anchors.forEach((anchor, anchorIndex) => {
    const projection = nearestSegmentProjection(path, anchor, closed);
    if (!projection) return;
    const left = path[projection.segmentIndex];
    const right = path[(projection.segmentIndex + 1) % path.length] ?? left;
    const base = projection.fraction <= 0.5 ? left : right;
    // A guide is an exact manual constraint, not automatically an image
    // observation. In particular, proximity to a synthesized bridge must not
    // promote masked/blank pixels to high-confidence measured ink.
    const observed = projection.distance <= 4 && !anchor.occlusionGuide
      && base.observed !== false && base.imageObserved !== false
      && bilinearTargetAffinity(imageOptions, anchor.x, anchor.y) >= 0.08;
    const guide = {
      ...base,
      ...anchor,
      observed,
      imageObserved: observed,
      confidence: observed ? 1 : Math.min(base.confidence ?? 0.55, 0.55),
      anchor: true,
      userGuided: true,
      origin: "guide",
    };
    if (!insertionsBySegment.has(projection.segmentIndex)) {
      insertionsBySegment.set(projection.segmentIndex, []);
    }
    insertionsBySegment.get(projection.segmentIndex).push({
      guide,
      fraction: projection.fraction,
      anchorIndex,
    });
  });
  const result = [];
  for (let index = 0; index < path.length; index += 1) {
    result.push({ ...path[index] });
    const insertions = insertionsBySegment.get(index) ?? [];
    insertions.sort((left, right) => (
      left.fraction - right.fraction || left.anchorIndex - right.anchorIndex
    ));
    result.push(...insertions.map(({ guide }) => guide));
  }
  return result.map((point, index) => ({ ...point, parametricOrder: index }));
}

/**
 * Extract a genuinely two-dimensional curve. This deliberately targets simple
 * closed cycles and simple open paths first; ordinary and near-vertical curves
 * keep the mature scan-line engines. The returned confidence lets automatic
 * selection reject branched or weak topology.
 */
export function traceParametricCurve({
  rgba,
  width,
  height,
  rect,
  anchors,
  target,
  threshold = 42,
  targetStyle = "line",
  exclusions = [],
  inclusionMask = null,
  refinementMode = "full",
}) {
  if (!rgba || rgba.length !== width * height * 4) {
    throw new Error("RGBA buffer dimensions do not match width and height");
  }
  if (!Array.isArray(anchors) || !anchors.length) {
    throw new Error("At least one curve anchor is required");
  }
  const maskRecord = buildTargetMask({
    rgba, width, height, rect, target, threshold, exclusions, inclusionMask, anchors,
  });
  const seedIndex = nearestMaskIndex(maskRecord, anchors);
  if (seedIndex < 0) return { path: [], closed: false, topologyConfidence: 0, reason: "seed-not-on-ink" };
  const component = floodComponent(maskRecord, seedIndex);
  const patternedStyle = ["dashed", "dotted", "dashdot"].includes(targetStyle);
  const patternedComponentCount = patternedStyle ? countMaskComponents(maskRecord) : 1;
  const minimumSeedComponent = patternedStyle ? 3 : exclusions.length ? 8 : 24;
  if (component.length < minimumSeedComponent || component.length > maskRecord.mask.length * 0.24) {
    return { path: [], closed: false, topologyConfidence: 0, reason: "component-size" };
  }
  let skeleton = skeletonize(cropComponent(maskRecord, component));
  let nodes = buildSkeletonGraph(skeleton);
  let graphBridges = { records: [], byEdge: new Map() };
  if (exclusions.length || patternedStyle || inclusionMask?.mode === "local") {
    const allInk = [];
    for (let index = 0; index < maskRecord.mask.length; index += 1) {
      if (maskRecord.mask[index]) allInk.push(index);
    }
    if (allInk.length >= 24 && allInk.length <= maskRecord.mask.length * 0.24) {
      const completeSkeleton = skeletonize(cropComponent(maskRecord, allInk));
      const completeNodes = buildSkeletonGraph(completeSkeleton);
      const entryBridges = connectLocalPenEntries(completeNodes, inclusionMask, width, height, maskRecord.safeRect, exclusions);
      const proposedBridges = exclusions.length
        ? connectOcclusionBridges(completeNodes, exclusions)
        : connectPatternedBridges(completeNodes, targetStyle);
      proposedBridges.records.push(...entryBridges);
      for (const bridge of entryBridges) proposedBridges.byEdge.set(edgeKey(bridge.left, bridge.right), bridge);
      if (proposedBridges.records.length) {
        skeleton = completeSkeleton;
        nodes = completeNodes;
        graphBridges = proposedBridges;
      }
    }
  }
  if (nodes.length < 16) return { path: [], closed: false, topologyConfidence: 0, reason: "skeleton-size" };
  const { active, degrees } = graphTwoCore(nodes);
  const selectedCycle = chooseCycleComponent(nodes, active, anchors);
  let selected = selectedCycle;
  let ordered = null;
  let closed = false;
  let simpleCycle = false;
  let eulerianCycle = false;
  let simplePath = false;
  let guidedBranchedPath = false;
  if (selectedCycle) {
    const start = nearestNodeIndex(nodes, selectedCycle.component, anchors[0]).index;
    ordered = orderedDegreeTwoCycle(nodes, active, selectedCycle.component, start);
    simpleCycle = Boolean(ordered);
    if (!ordered) {
      ordered = orderedEulerianCycle(nodes, active, selectedCycle.component, start);
      eulerianCycle = Boolean(ordered);
    }
    if (!ordered) ordered = orderedBranchedCycle(nodes, active, start, anchors);
    if (ordered?.length) {
      ordered = rotateCycleToStart(ordered, start);
      ordered = orientCycleByGuides(nodes, ordered, anchors);
      closed = true;
    }
  }
  if (!ordered?.length) {
    selected = chooseOpenComponent(nodes, anchors);
    ordered = orderedSimpleOpenPath(nodes, selected, anchors);
    simplePath = Boolean(ordered);
    closed = false;
  }
  if (!ordered?.length) {
    selected = chooseGuidedBranchedComponent(nodes, anchors);
    ordered = orderedGuidedBranchedPath(nodes, selected, anchors);
    guidedBranchedPath = Boolean(ordered);
    closed = false;
  }
  if (!ordered?.length || !selected) {
    const nodeIndices = nodes.map((_, index) => index);
    return { path: [], closed: false, topologyConfidence: 0, reason: "no-simple-2d-path",
      guideDistances: anchors.map(anchor => nearestNodeIndex(nodes, nodeIndices, anchor).distance),
      endpointCount: nodes.filter(node => node.neighbors.length === 1).length,
      nodeCount: nodes.length,
    };
  }
  const usedBridgeKeys = new Set();
  for (let index = 0; index < ordered.length - 1; index += 1) {
    const key = edgeKey(ordered[index], ordered[index + 1]);
    if (graphBridges.byEdge.has(key)) usedBridgeKeys.add(key);
  }
  if (closed && ordered.length > 1) {
    const seamKey = edgeKey(ordered.at(-1), ordered[0]);
    if (graphBridges.byEdge.has(seamKey)) usedBridgeKeys.add(seamKey);
  }
  const usedGraphBridges = [...usedBridgeKeys].map((key) => graphBridges.byEdge.get(key));
  const usedOcclusionBridges = usedGraphBridges.filter((bridge) => bridge.kind === "occlusion");
  const usedPatternedBridges = usedGraphBridges.filter((bridge) => bridge.kind === "pattern-gap");
  if (patternedStyle && patternedComponentCount > 1 && usedPatternedBridges.length < 3) {
    return {
      path: [],
      closed: false,
      topologyConfidence: 0,
      reason: "pattern-reconnection-failed",
      patternedComponentCount,
      patternedBridgesProposed: graphBridges.records.filter((bridge) => bridge.kind === "pattern-gap").length,
    };
  }
  const pointConfidence = simpleCycle || simplePath ? 0.94 : guidedBranchedPath ? 0.68 : 0.72;
  let path = expandOrderedNodes(nodes, ordered, graphBridges.byEdge, {
    closed,
    confidence: pointConfidence,
    topologyReview: eulerianCycle || guidedBranchedPath,
  });
  const imageOptions = {
    rgba,
    width,
    height,
    rect: maskRecord.safeRect,
    target,
    threshold,
    exclusions,
    inclusionMask,
  };
  path = insertExactGuides(path, anchors, { closed, imageOptions });
  if (refinementMode !== "off") path = refineParametricCenterline(path, imageOptions, { closed });
  path = path.map((point, index) => ({
    ...point,
    traceOrientation: "parametric",
    closedPath: closed,
    parametricOrder: index,
  }));
  const branchFraction = closed
    ? selected.component.filter((index) => degrees[index] > 2).length / selected.component.length
    : selected.branches / selected.component.length;
  const occlusionBridgePenalty = usedOcclusionBridges.reduce((sum, bridge) => (
    sum + 0.025 + (1 - bridge.confidence) * 0.12
  ), 0);
  const meanPatternedBridgeConfidence = usedPatternedBridges.length
    ? usedPatternedBridges.reduce((sum, bridge) => sum + bridge.confidence, 0) / usedPatternedBridges.length
    : 1;
  const patternedBridgePenalty = usedPatternedBridges.length
    ? 0.025 + (1 - meanPatternedBridgeConfidence) * 0.08
    : 0;
  const topologyConfidence = clamp(
    (simpleCycle ? 0.98 : simplePath ? 0.97 : eulerianCycle ? 0.84 : guidedBranchedPath ? 0.72 : 0.76)
      - branchFraction * 2.4
      - Math.min(0.35, selected.meanAnchorDistance * 0.035)
      - Math.min(0.16, occlusionBridgePenalty + patternedBridgePenalty),
    0,
    1,
  );
  return {
    path,
    closed,
    topology: eulerianCycle
      ? "self-intersecting-cycle"
      : guidedBranchedPath ? "guided-branched-path" : closed ? "closed-cycle" : "open-path",
    topologyConfidence,
    componentPixels: component.length,
    skeletonPixels: nodes.length,
    cyclePixels: path.length,
    arcLength: pathArcLength(path, closed),
    simpleCycle,
    eulerianCycle,
    simplePath,
    guidedBranchedPath,
    occlusionBridges: usedOcclusionBridges.length,
    patternedBridges: usedPatternedBridges.length,
    penEntryBridges: usedGraphBridges.filter(bridge => bridge.kind === "pen-entry").length,
    patternedBridgesProposed: graphBridges.records.filter((bridge) => bridge.kind === "pattern-gap").length,
    patternedComponentCount,
    patternGapMedian: graphBridges.medianGap ?? null,
    patternGapConsistency: graphBridges.gapConsistency ?? null,
    inferredPixels: path.filter((point) => point.observed === false).length,
    branchFraction,
    thinningIterations: skeleton.thinningIterations,
  };
}
