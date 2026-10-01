// Shared binary-mask geometry; independent of image colours and tracing state.
const neighborOffsets = [[0,-1],[1,-1],[1,0],[1,1],[0,1],[-1,1],[-1,0],[-1,-1]];

function neighborValues(mask, width, index) {
  const north = index - width;
  return [
    mask[north],
    mask[north + 1],
    mask[index + 1],
    mask[index + width + 1],
    mask[index + width],
    mask[index + width - 1],
    mask[index - 1],
    mask[north - 1],
  ];
}

function transitionCount(neighbors) {
  let transitions = 0;
  for (let index = 0; index < neighbors.length; index += 1) {
    if (!neighbors[index] && neighbors[(index + 1) % neighbors.length]) transitions += 1;
  }
  return transitions;
}

export function skeletonizeMask(componentRecord) {
  const { width, height } = componentRecord;
  const mask = new Uint8Array(componentRecord.mask);
  const removed = [];
  const maximumIterations = Math.max(24, Math.min(256, Math.ceil(Math.max(width, height) / 2)));
  let iteration = 0;
  let changed = true;
  while (changed && iteration < maximumIterations) {
    changed = false;
    iteration += 1;
    for (let phase = 0; phase < 2; phase += 1) {
      removed.length = 0;
      for (let y = 1; y < height - 1; y += 1) {
        for (let x = 1; x < width - 1; x += 1) {
          const index = y * width + x;
          if (!mask[index]) continue;
          const neighbors = neighborValues(mask, width, index);
          const count = neighbors.reduce((sum, value) => sum + value, 0);
          if (count < 2 || count > 6 || transitionCount(neighbors) !== 1) continue;
          const [north, northEast, east, southEast, south, southWest, west] = neighbors;
          const firstCondition = phase === 0
            ? north * east * south === 0 && east * south * west === 0
            : north * east * west === 0 && north * south * west === 0;
          if (!firstCondition) continue;
          removed.push(index);
        }
      }
      if (removed.length) {
        changed = true;
        for (const index of removed) mask[index] = 0;
      }
    }
  }
  return { ...componentRecord, mask, thinningIterations: iteration };
}

export function buildMaskGraph(skeleton) {
  const { mask, width, height, offsetX, offsetY } = skeleton;
  const nodeAt = new Int32Array(mask.length);
  nodeAt.fill(-1);
  const nodes = [];
  for (let index = 0; index < mask.length; index += 1) {
    if (!mask[index]) continue;
    const localX = index % width;
    const localY = Math.floor(index / width);
    nodeAt[index] = nodes.length;
    nodes.push({
      x: offsetX + localX,
      y: offsetY + localY,
      localX,
      localY,
      neighbors: [],
    });
  }
  for (let nodeIndex = 0; nodeIndex < nodes.length; nodeIndex += 1) {
    const node = nodes[nodeIndex];
    for (const [dx, dy] of neighborOffsets) {
      const x = node.localX + dx;
      const y = node.localY + dy;
      if (x < 0 || x >= width || y < 0 || y >= height) continue;
      const neighborIndex = nodeAt[y * width + x];
      if (neighborIndex < 0) continue;
      if (dx !== 0 && dy !== 0) {
        // Suppress diagonal shortcuts across an existing orthogonal corner.
        // The diagonal is retained when it is the only connection, so true
        // diagonal strokes remain continuous without turning every corner into
        // a three-node micro-cycle.
        const horizontalBridge = nodeAt[node.localY * width + x] >= 0;
        const verticalBridge = nodeAt[y * width + node.localX] >= 0;
        if (horizontalBridge || verticalBridge) continue;
      }
      node.neighbors.push(neighborIndex);
    }
  }
  return nodes;
}
